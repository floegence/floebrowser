import { randomBytes } from 'node:crypto';
import { MEDIA_WIRE_VERSION } from '../shared/media-wire.js';
import type { Page } from 'playwright';
import type { SourceDialog, SourcePage } from './source.js';
import {
  StandaloneSourceDirectory,
  type SourceDirectory,
  type DirectoryChange,
} from './directory.js';
import { PlaywrightSourceBrowser } from './playwright-source.js';
import { DownloadTransfers } from './downloads.js';
import {
  BrowserProjection,
  type AttachOptions,
  type Controller,
  type Observation,
  type ObservationOptions,
} from './engine.js';
import {
  clientMessageSchema,
  MAX_PENDING_COMMANDS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type TabState,
  type DownloadFile,
} from '../shared/protocol.js';

type Tab = { page: SourcePage; engine: BrowserProjection };
type DirectoryClose = {
  viewer: Viewer;
  page: SourcePage;
  authorize: AttachOptions['authorize'];
  dialog?: SourceDialog;
  id?: string;
};
export interface SessionViewOptions extends ObservationOptions {
  initialTab?: string;
  /** Synchronous host grant predicate. Call refreshGrants after changing it. */
  canObserve?: (page: SourcePage) => boolean;
  /** Independent per-source audio-output grant. Refresh after ownership changes. */
  canHear?: (page: SourcePage) => boolean;
}
type Viewer = {
  transfers: DownloadTransfers;
  id: string;
  active: boolean;
  selected: string;
  revision: number;
  queue: Promise<void>;
  directoryWork: Promise<void>;
  send: (message: ServerMessage) => void;
  options: SessionViewOptions;
  visible: boolean;
  controller?: Controller;
  observation?: Observation;
  observations: Map<string, Observation>;
  authorize?: AttachOptions['authorize'];
  directoryAuthorize?: AttachOptions['authorize'];
  canControl?: (page: SourcePage) => boolean;
  mediaEnabled: boolean;
  lastID: number;
  pending: number;
  retiring: Map<Promise<void>, Controller | undefined>;
  retirementFailure?: unknown;
};
export interface SessionConnection extends Controller {
  readonly id: string;
  readonly currentState: TabState;
  setMedia(enabled: boolean): Promise<void>;
  setAudio(enabled: boolean): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  /** Explicit directory authority, independent of page input. Watching permits
   * selecting an observed page; an installed predicate may further restrict it.
   * Clearing this predicate
   * fences pending directory authorization and updates the browser chrome. */
  setDirectoryAuthority(authorize?: AttachOptions['authorize']): void;
  /** Host-only grant. By default it covers only the currently selected source.
   * A dynamic predicate must reflect the host's target leases. This never grants
   * directory editing. Returns false instead of stealing control. */
  acquireControl(
    authorize: AttachOptions['authorize'],
    canControl?: (page: SourcePage) => boolean,
  ): Promise<boolean>;
  releaseControl(): Promise<void>;
  /** Handles only a pending directory-owned close decision. Hosts may route
   * this separately from page input; false grants no other action authority. */
  receiveDirectoryDecision(message: ClientMessage): Promise<boolean>;
  download(
    tab: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<DownloadFile>;
  /** Revokes removed observation grants synchronously before returning the drain. */
  refreshGrants(): Promise<void>;
  readResource(
    tab: string,
    id: string,
  ): ReturnType<BrowserProjection['resources']['read']>;
}

/** One projection owner per authorized source; each view selects independently.
 * The host owns source grants, lifecycle and user/AI target-control policy. */
export class BrowserSession {
  private downloadTargets = new Map<SourcePage, () => void>();
  private tabs = new Map<string, Tab>();
  private adding = new Map<SourcePage, Promise<Tab>>();
  private viewers = new Set<Viewer>();
  private standaloneViewer?: Viewer;
  private resumeTab = '';
  private directoryOrder: string[] = [];
  private unsubscribe?: () => void;
  private closing?: Promise<void>;
  private directoryClosures = new Map<string, DirectoryClose>();
  private constructor(
    private directory: SourceDirectory,
    private options: AttachOptions,
    private owner?: PlaywrightSourceBrowser,
    private standalone?: StandaloneSourceDirectory,
  ) {}

  static async attach(
    page: Page | SourcePage,
    options: AttachOptions,
  ): Promise<BrowserSession> {
    const owner =
      'transport' in page ? undefined : new PlaywrightSourceBrowser();
    const source = 'transport' in page ? page : await owner!.adopt(page);
    const directory = new StandaloneSourceDirectory(source);
    const session = new BrowserSession(directory, options, owner, directory);
    try {
      await session.start();
    } catch (error) {
      directory.dispose();
      await owner?.dispose();
      throw error;
    }
    return session;
  }
  static async open(
    directory: SourceDirectory,
    options: AttachOptions,
  ): Promise<BrowserSession> {
    const session = new BrowserSession(directory, options);
    await session.start();
    return session;
  }
  private async start(): Promise<void> {
    this.unsubscribe = this.directory.subscribe((change) =>
      this.directoryChanged(change),
    );
    try {
      const entries = this.entries();
      this.watchDownloads();
      this.directoryOrder = entries.map((entry) => entry.page.id);
      if (entries[0]) {
        await this.add(entries[0].page);
        this.resumeTab = entries[0].page.id;
      }
    } catch (error) {
      this.unsubscribe();
      for (const dispose of this.downloadTargets.values()) dispose();
      this.downloadTargets.clear();
      throw error;
    }
  }
  private entries(viewer?: Viewer) {
    const entries = this.directory
      .list()
      .filter(
        (entry) =>
          !entry.page.isClosed() &&
          (!viewer?.options.canObserve ||
            viewer.options.canObserve(entry.page)),
      );
    if (new Set(entries.map((entry) => entry.page.id)).size !== entries.length)
      throw new Error('Duplicate source target identity');
    return entries;
  }
  private directoryChanged(change: DirectoryChange): void {
    if (this.closing) return;
    this.watchDownloads();
    const ids = this.entries().map((entry) => entry.page.id);
    const previous = this.directoryOrder;
    this.directoryOrder = ids;
    for (const id of this.tabs.keys()) if (!ids.includes(id)) this.drop(id);
    for (const viewer of this.viewers)
      void this.refreshGrants(viewer, change, previous).catch(() =>
        this.unavailable(viewer),
      );
    if (!ids.includes(this.resumeTab)) this.resumeTab = ids[0] ?? '';
  }
  private refreshGrants(
    viewer: Viewer,
    change: DirectoryChange = {},
    previous = this.directoryOrder,
  ): Promise<void> {
    if (!viewer.active) return Promise.resolve();
    const selected = this.tabs.get(viewer.selected);
    if (
      viewer.controller &&
      (!selected || !viewer.canControl?.(selected.page))
    ) {
      const control = viewer.controller;
      viewer.controller = undefined;
      this.trackRetirement(viewer, control.close());
    }
    const ids = this.entries(viewer).map((entry) => entry.page.id);
    for (const close of this.directoryClosures.values())
      if (close.viewer === viewer && !ids.includes(close.page.id))
        this.trackRetirement(viewer, this.dismissDirectoryDialog(close));
    viewer.transfers.retain((page) => ids.includes(page.id));
    for (const [id, observation] of viewer.observations)
      if (!ids.includes(id)) {
        viewer.observations.delete(id);
        if (viewer.observation === observation) this.retire(viewer);
        this.trackRetirement(viewer, observation.close());
      } else {
        this.trackRetirement(
          viewer,
          observation.setAudio(this.canHear(viewer, id)),
        );
      }
    let next = viewer.selected;
    if (!ids.includes(next)) {
      const position = Math.max(0, previous.indexOf(next));
      next =
        previous.slice(position + 1).find((id) => ids.includes(id)) ??
        previous
          .slice(0, position)
          .reverse()
          .find((id) => ids.includes(id)) ??
        ids[0] ??
        '';
    }
    if (change.activate && ids.includes(change.activate))
      next = change.activate;
    if (next !== viewer.selected) {
      this.retire(viewer);
      viewer.selected = next;
      ++viewer.revision;
      if (viewer === this.standaloneViewer) this.resumeTab = next;
      viewer.directoryWork = next
        ? this.select(viewer, next).catch(() => this.unavailable(viewer))
        : Promise.resolve();
    }
    this.publish(viewer);
    this.publishDownloads(viewer);
    return Promise.all([viewer.directoryWork, ...viewer.retiring.keys()]).then(
      () => {},
    );
  }
  private watchDownloads(): void {
    const entries = this.entries();
    for (const [page, dispose] of this.downloadTargets)
      if (!entries.some((entry) => entry.page === page)) {
        dispose();
        this.downloadTargets.delete(page);
      }
    for (const { page } of entries)
      if (!this.downloadTargets.has(page)) {
        const changed = () => {
          for (const viewer of this.viewers)
            this.publishDownloads(viewer, page);
        };
        page.on('downloadschanged', changed);
        this.downloadTargets.set(page, () =>
          page.off('downloadschanged', changed),
        );
      }
  }
  private publishDownloads(viewer: Viewer, target?: SourcePage): void {
    if (!viewer.active) return;
    for (const { page } of this.entries(viewer))
      if (!target || target === page)
        viewer.send({
          type: 'downloads',
          target: page.id,
          items: page.downloads().map((download) => ({
            ...download.state,
            filename: download.state.filename.slice(0, 1024),
          })),
        });
  }
  /** Standalone convenience; embedded consumers use their connection's state. */
  get activeProjection(): BrowserProjection {
    return this.tabs.get(this.standaloneViewer?.selected ?? this.resumeTab)!
      .engine;
  }
  get hasController(): boolean {
    return !!this.standaloneViewer?.active;
  }
  get currentState(): TabState {
    return this.state(this.standaloneViewer);
  }
  private state(viewer?: Viewer): TabState {
    return {
      active: viewer?.selected ?? this.resumeTab,
      tabs: this.entries(viewer).map(({ page, title, pinned, loading }) => {
        const state = this.tabs.get(page.id)?.engine.currentState;
        return {
          id: page.id,
          title: state?.title || title || '',
          url: state?.url || page.url(),
          pinned: !!pinned,
          loading: state?.loading ?? !!loading,
        };
      }),
    };
  }
  private publish(viewer?: Viewer): void {
    if (viewer) {
      if (viewer.active)
        viewer.send({ type: 'tabs', state: this.state(viewer) });
    } else for (const view of this.viewers) this.publish(view);
  }
  private canHear(viewer: Viewer, id: string): boolean {
    const page = this.tabs.get(id)?.page;
    return Boolean(
      page &&
      viewer.options.audio !== false &&
      (!viewer.options.canHear || viewer.options.canHear(page)),
    );
  }
  private enqueue(viewer: Viewer, work: () => Promise<void>): Promise<void> {
    const result = viewer.queue.then(work);
    viewer.queue = result.catch(() => {});
    return result;
  }
  private add(page: SourcePage): Promise<Tab> {
    if (this.closing) return Promise.reject(new Error('Session closed'));
    const existing = this.tabs.get(page.id);
    if (existing) {
      if (existing.page !== page)
        return Promise.reject(new Error('Source identity reused'));
      return Promise.resolve(existing);
    }
    const pending = this.adding.get(page);
    if (pending) return pending;
    const task = (async () => {
      const engine = await BrowserProjection.attach(page, {
        ...this.options,
        onState: (state) => {
          this.options.onState?.(state);
          if (state.status === 'closed') this.directoryChanged({});
          else this.publish();
        },
        onPopup: () => {}, // Only the directory owner can admit popups.
        onUncontrolledDialog: (dialog, source) =>
          this.directoryDialog(dialog, source),
      });
      if (
        this.closing ||
        !this.entries().some((entry) => entry.page === page)
      ) {
        await engine.close();
        throw new Error('Source grant revoked while attaching a tab');
      }
      const tab = { page, engine };
      this.tabs.set(page.id, tab);
      this.publish();
      return tab;
    })().finally(() => this.adding.delete(page));
    this.adding.set(page, task);
    return task;
  }
  /** Trusted host entry point for AI control. Shares the exact same projection
   * and debugger as viewers; calling it does not grant input or observation. */
  async projection(id: string): Promise<BrowserProjection> {
    const entry = this.entries().find((entry) => entry.page.id === id);
    if (!entry) throw new Error('Unknown source target');
    return (await this.add(entry.page)).engine;
  }
  private unavailable(viewer: Viewer): void {
    if (viewer.active) viewer.send({ type: 'notice', code: 'tab_unavailable' });
  }
  private trackRetirement(
    viewer: Viewer,
    work: Promise<void>,
    controller?: Controller,
  ): void {
    viewer.retiring.set(work, controller);
    void work
      .catch((error) => {
        viewer.retirementFailure ??= error;
      })
      .finally(() => viewer.retiring.delete(work));
  }
  private async drainRetirements(viewer: Viewer): Promise<void> {
    await Promise.allSettled(viewer.retiring.keys());
    if (viewer.retirementFailure) throw viewer.retirementFailure;
  }
  private retire(viewer: Viewer): void {
    for (const close of this.directoryClosures.values())
      if (close.viewer === viewer && close.dialog)
        this.trackRetirement(viewer, this.dismissDirectoryDialog(close));
    const observation = viewer.observation;
    const controller = viewer.controller;
    viewer.controller = undefined;
    viewer.observation = undefined;
    if (observation)
      this.trackRetirement(viewer, observation.setVisible(false), controller);
  }
  private closeObservations(viewer: Viewer): void {
    for (const close of this.directoryClosures.values())
      if (close.viewer === viewer)
        this.trackRetirement(viewer, this.dismissDirectoryDialog(close));
    viewer.transfers.close();
    viewer.controller = undefined;
    viewer.observation = undefined;
    for (const observation of viewer.observations.values())
      this.trackRetirement(viewer, observation.close());
    viewer.observations.clear();
  }
  private async control(viewer: Viewer): Promise<boolean> {
    const observation = viewer.observation,
      tab = this.tabs.get(viewer.selected),
      authorize = viewer.authorize,
      canControl = viewer.canControl;
    if (
      !viewer.active ||
      !viewer.visible ||
      !observation ||
      !tab ||
      !authorize ||
      !canControl?.(tab.page)
    )
      return false;
    if (viewer.controller) return true;
    if (tab.engine.hasController) return false;
    const admitted = () =>
      viewer.active &&
      viewer.visible &&
      viewer.observation === observation &&
      viewer.authorize === authorize &&
      viewer.canControl === canControl &&
      canControl(tab.page) &&
      this.entries(viewer).some((entry) => entry.page === tab.page);
    let controller: Controller;
    try {
      controller = await tab.engine.acquireControl(
        observation,
        authorize,
        admitted,
      );
    } catch {
      // A terminal source-control fault does not revoke authorized viewing or
      // the session directory. A healthy tab can still be selected.
      return false;
    }
    if (!admitted()) {
      this.trackRetirement(viewer, controller.close());
      return false;
    }
    viewer.controller = controller;
    // Chromium can retry an error document when its target is foregrounded.
    // Selecting or reconnecting that view must preserve the failure until the
    // user explicitly navigates or reloads, for embedded and standalone views.
    if (tab.engine.currentState.status !== 'error')
      void tab.page.bringToFront().catch(() => {});
    return true;
  }
  private async select(viewer: Viewer, id: string): Promise<void> {
    const entry = this.entries(viewer).find((entry) => entry.page.id === id);
    if (!entry) throw new Error('Unknown source tab');
    this.retire(viewer);
    viewer.selected = id;
    if (viewer === this.standaloneViewer) this.resumeTab = id;
    this.publish(viewer);
    const tab = await this.add(entry.page);
    if (!viewer.active || viewer.selected !== id || this.closing) return;
    // Only an input owner may activate the physical source page. Watching does
    // not change AI's target, focus, viewport or personal-browser selection.
    const observation =
      viewer.observations.get(id) ??
      (await tab.engine.observe(
        (message) => {
          if (
            message.type === 'control' &&
            message.target === viewer.selected &&
            !message.active
          )
            viewer.controller = undefined;
          if (
            viewer.active &&
            message.type !== 'downloads' &&
            (message.type === 'ack' ||
              message.type === 'media_end' ||
              (message.type === 'control' && !message.active) ||
              (this.entries(viewer).some((entry) => entry.page.id === id) &&
                (message.type === 'media' ||
                  (viewer.selected === id &&
                    !(
                      message.type === 'state' &&
                      message.state.status === 'closed'
                    )))))
          )
            viewer.send(message);
        },
        {
          ...viewer.options,
          media: viewer.mediaEnabled,
          audio: this.canHear(viewer, id),
          visible: viewer.visible,
          onMediaFrame: viewer.options.onMediaFrame
            ? (frame) => {
                if (
                  viewer.active &&
                  this.entries(viewer).some((entry) => entry.page.id === id) &&
                  (frame.header.track !== 'audio' || this.canHear(viewer, id))
                )
                  viewer.options.onMediaFrame?.(frame);
              }
            : undefined,
        },
      ));
    if (
      !viewer.active ||
      !this.entries(viewer).some((entry) => entry.page.id === id)
    ) {
      await observation.close();
      return;
    }
    viewer.observations.set(id, observation);
    if (viewer.selected !== id) {
      this.trackRetirement(viewer, observation.setVisible(false));
      return;
    }
    this.trackRetirement(viewer, observation.setVisible(viewer.visible));
    viewer.observation = observation;
    await this.control(viewer);
  }
  private drop(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    for (const viewer of this.viewers) {
      if (viewer.selected === id) this.retire(viewer);
      const observation = viewer.observations.get(id);
      viewer.observations.delete(id);
      if (observation) this.trackRetirement(viewer, observation.close());
    }
    void tab.engine.close();
    this.tabs.delete(id);
  }
  async observe(
    send: (message: ServerMessage) => void,
    options: SessionViewOptions = {},
  ): Promise<SessionConnection> {
    if (this.closing || this.viewers.size >= 16)
      throw new Error('Session unavailable');
    const viewer: Viewer = {
      transfers: new DownloadTransfers(),
      id: randomBytes(18).toString('base64url'),
      active: true,
      selected: '',
      revision: 0,
      queue: Promise.resolve(),
      directoryWork: Promise.resolve(),
      send,
      options: { ...options },
      visible: options.visible !== false,
      observations: new Map(),
      mediaEnabled: options.media !== false,
      lastID: 0,
      pending: 0,
      retiring: new Map(),
    };
    const entries = this.entries(viewer);
    viewer.selected =
      entries.find(
        (entry) => entry.page.id === (options.initialTab ?? this.resumeTab),
      )?.page.id ??
      entries[0]?.page.id ??
      '';
    this.viewers.add(viewer);
    try {
      send({ type: 'session_access', editTabs: false });
      if (viewer.selected) await this.select(viewer, viewer.selected);
      else {
        send({
          type: 'hello',
          version: PROTOCOL_VERSION,
          mediaWireVersion: MEDIA_WIRE_VERSION,
        });
        this.publish(viewer);
      }
      this.publishDownloads(viewer);
    } catch (error) {
      viewer.active = false;
      this.closeObservations(viewer);
      this.viewers.delete(viewer);
      throw error;
    }
    let closed: Promise<void> | undefined;
    const session = this;
    return {
      id: viewer.id,
      get currentState() {
        return session.state(viewer);
      },
      receive: (message) => this.receive(viewer, message),
      receiveDirectoryDecision: async (input) => {
        const parsed = clientMessageSchema.safeParse(input);
        if (!parsed.success) return false;
        const message = parsed.data;
        if (
          message.type !== 'command' ||
          message.action.kind !== 'dialog_reply'
        )
          return false;
        const close = this.directoryClosures.get(message.tab);
        if (
          close?.viewer !== viewer ||
          !close.dialog ||
          close.id !== message.action.dialog
        )
          return false;
        await this.receive(viewer, message);
        return true;
      },
      upload: (id, file, body, signal) => {
        if (
          !viewer.active ||
          !viewer.controller ||
          !this.entries(viewer).some(
            (entry) => entry.page.id === viewer.selected,
          )
        )
          return Promise.reject(new Error('Source control unavailable'));
        return viewer.controller.upload(id, file, body, signal);
      },
      setMedia: async (enabled) => {
        if (!viewer.active) return;
        viewer.mediaEnabled = enabled;
        await Promise.all(
          [...viewer.observations.values()].map((observation) =>
            observation.setMedia(enabled),
          ),
        );
      },
      setAudio: async (enabled) => {
        if (!viewer.active) return;
        viewer.options.audio = enabled;
        await Promise.all(
          [...viewer.observations].map(([id, observation]) =>
            observation.setAudio(this.canHear(viewer, id)),
          ),
        );
      },
      setVisible: async (visible) => {
        if (!viewer.active || viewer.visible === visible) return;
        viewer.visible = visible;
        if (!visible) this.retire(viewer);
        else if (viewer.selected) await this.select(viewer, viewer.selected);
      },
      setDirectoryAuthority: (authorize) => {
        if (!viewer.active) return;
        viewer.directoryAuthorize = authorize;
        for (const close of this.directoryClosures.values())
          if (close.viewer === viewer && close.authorize !== authorize)
            this.trackRetirement(viewer, this.dismissDirectoryDialog(close));
        send({ type: 'session_access', editTabs: Boolean(authorize) });
      },
      acquireControl: async (authorize, canControl) => {
        if (!viewer.active) return false;
        const selected = this.tabs.get(viewer.selected)?.page;
        const previous = viewer.controller;
        const grant = canControl ?? ((page: SourcePage) => page === selected);
        viewer.controller = undefined;
        viewer.authorize = authorize;
        viewer.canControl = grant;
        if (previous) await previous.close();
        if (viewer.authorize !== authorize || viewer.canControl !== grant)
          return false;
        return this.control(viewer);
      },
      releaseControl: async () => {
        viewer.authorize = undefined;
        viewer.canControl = undefined;
        const control = viewer.controller;
        viewer.controller = undefined;
        for (const retiring of new Set([control, ...viewer.retiring.values()]))
          if (retiring) this.trackRetirement(viewer, retiring.close());
        await this.drainRetirements(viewer);
      },
      refreshGrants: () => this.refreshGrants(viewer),
      readResource: (tab, id) => this.readViewerResource(viewer, tab, id),
      download: async (tab, id, signal) => {
        const page = this.entries(viewer).find(
          (entry) => entry.page.id === tab,
        )?.page;
        const authorized = () =>
          viewer.active &&
          this.entries(viewer).some((entry) => entry.page === page);
        if (!page || !authorized()) throw new Error('Download unavailable');
        return viewer.transfers.open(page, id, authorized, signal);
      },
      close: () =>
        (closed ??= (async () => {
          viewer.active = false;
          viewer.authorize = undefined;
          viewer.canControl = undefined;
          viewer.directoryAuthorize = undefined;
          this.closeObservations(viewer);
          this.viewers.delete(viewer);
          await viewer.queue;
          await this.drainRetirements(viewer);
        })()),
    };
  }
  /** Exclusive standalone convenience. Embedded windows use observe() and a
   * separate host-authorized acquireControl(), allowing concurrent observers. */
  async connect(
    send: (message: ServerMessage) => void,
    options: SessionViewOptions = {},
  ): Promise<SessionConnection> {
    if (this.hasController || this.closing)
      throw new Error('Session unavailable');
    const connection = await this.observe(send, {
      ...this.options,
      ...options,
    });
    const viewer = [...this.viewers].find(
      (viewer) => viewer.id === connection.id,
    )!;
    if (this.hasController) {
      await connection.close();
      throw new Error('Session unavailable');
    }
    this.standaloneViewer = viewer;
    this.resumeTab = viewer.selected;
    connection.setDirectoryAuthority(this.options.authorize);
    await connection.acquireControl(this.options.authorize, () => true);
    return connection;
  }
  private receive(viewer: Viewer, input: ClientMessage): Promise<void> {
    if (!viewer.active) return Promise.resolve();
    const parsed = clientMessageSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve();
    const message = parsed.data;
    if (
      viewer.selected &&
      !this.entries(viewer).some((entry) => entry.page.id === viewer.selected)
    )
      void this.refreshGrants(viewer).catch(() => this.unavailable(viewer));
    if (message.type === 'media_keyframe')
      return (
        viewer.observations.get(message.tab)?.receive(message) ??
        Promise.resolve()
      );
    if (message.type === 'resync')
      return viewer.observation?.receive(message) ?? Promise.resolve();
    const ack = (
      code?: 'stale_view' | 'busy' | 'not_allowed' | 'action_failed',
    ) => {
      if (viewer.active)
        viewer.send({ type: 'ack', id: message.id, ok: !code, code });
    };
    if (message.id <= viewer.lastID) {
      ack('stale_view');
      return Promise.resolve();
    }
    viewer.lastID = message.id;
    if (message.tab !== viewer.selected) {
      ack('stale_view');
      return Promise.resolve();
    }
    const closing = this.directoryClosures.get(message.tab);
    const action = message.action;
    if (
      action.kind === 'dialog_reply' &&
      closing?.viewer === viewer &&
      closing.id === action.dialog &&
      closing.dialog
    ) {
      const dialog = closing.dialog;
      return (async () => {
        const permitted = await closing.authorize({
          kind: 'tab_close',
          tab: message.tab,
        });
        if (
          !permitted ||
          !viewer.active ||
          viewer.directoryAuthorize !== closing.authorize ||
          closing.dialog !== dialog ||
          !this.entries(viewer).some((entry) => entry.page === closing.page)
        ) {
          ack('not_allowed');
          return;
        }
        this.clearDirectoryDialog(closing);
        await dialog.respond(action.accept);
        ack();
      })().catch(() => ack('action_failed'));
    }
    if (!message.action.kind.startsWith('tab_')) {
      if (viewer.controller) return viewer.controller.receive(message);
      ack('not_allowed');
      return Promise.resolve();
    }
    if (!viewer.directoryAuthorize && message.action.kind !== 'tab_select') {
      ack('not_allowed');
      return Promise.resolve();
    }
    if (viewer.pending >= MAX_PENDING_COMMANDS) {
      ack('busy');
      return Promise.resolve();
    }
    const revision = ['tab_move', 'tab_pin'].includes(message.action.kind)
      ? viewer.revision
      : ++viewer.revision;
    viewer.pending++;
    let operation: Promise<void> | undefined;
    const admission = this.enqueue(viewer, async () => {
      if (!viewer.active) return;
      if (message.tab !== viewer.selected) {
        ack('stale_view');
        return;
      }
      const action = message.action,
        authorize = viewer.directoryAuthorize;
      if (
        (action.kind !== 'tab_select' && !authorize) ||
        (authorize && !(await authorize(action)))
      ) {
        ack('not_allowed');
        return;
      }
      if (
        !viewer.active ||
        message.tab !== viewer.selected ||
        viewer.directoryAuthorize !== authorize
      ) {
        if (viewer.active)
          ack(
            viewer.directoryAuthorize !== authorize
              ? 'not_allowed'
              : 'stale_view',
          );
        return;
      }
      operation = (async () => {
        if (action.kind === 'tab_new' || action.kind === 'tab_restore') {
          const page =
            action.kind === 'tab_new'
              ? await this.directory.create()
              : await this.directory.restore();
          if (page && viewer.active && revision === viewer.revision)
            await this.select(viewer, page.id);
        } else if ('tab' in action) {
          const ids = this.entries(viewer).map((entry) => entry.page.id);
          if (
            !ids.includes(action.tab) ||
            (action.kind === 'tab_move' &&
              action.before !== null &&
              !ids.includes(action.before))
          ) {
            ack('stale_view');
            return;
          }
          if (action.kind === 'tab_move')
            await this.directory.move(action.tab, action.before);
          else if (action.kind === 'tab_pin')
            await this.directory.pin(action.tab, action.pinned);
          else if (action.kind === 'tab_select')
            await this.select(viewer, action.tab);
          else if (action.kind === 'tab_close') {
            if (this.directoryClosures.has(action.tab)) {
              ack('busy');
              return;
            }
            const page = this.entries(viewer).find(
              (entry) => entry.page.id === action.tab,
            )!.page;
            const closing: DirectoryClose = {
              viewer,
              page,
              authorize: authorize!,
            };
            this.directoryClosures.set(action.tab, closing);
            try {
              await this.directory.close(action.tab);
              await viewer.directoryWork;
            } finally {
              await this.dismissDirectoryDialog(closing);
              this.directoryClosures.delete(action.tab);
            }
          }
        }
        ack();
      })();
      void operation.catch(() => {});
    });
    return admission
      .then(() => operation)
      .catch(() => ack('action_failed'))
      .finally(() => {
        viewer.pending--;
      });
  }
  private clearDirectoryDialog(close: DirectoryClose): void {
    const pending = close.dialog;
    close.dialog = undefined;
    close.id = undefined;
    if (pending) {
      try {
        close.viewer.send({
          type: 'dialog',
          target: close.page.id,
          dialog: null,
        });
      } catch {
        /* The former carrier may have closed. */
      }
    }
  }
  private async dismissDirectoryDialog(close: DirectoryClose): Promise<void> {
    const dialog = close.dialog;
    this.clearDirectoryDialog(close);
    await dialog?.respond(false);
  }
  private directoryDialog(dialog: SourceDialog, page: SourcePage): void {
    const close = this.directoryClosures.get(page.id);
    const permitted = () =>
      close &&
      close.viewer.active &&
      close.viewer.directoryAuthorize === close.authorize &&
      this.entries(close.viewer).some((entry) => entry.page === page);
    if (!close || dialog.type !== 'beforeunload') {
      if (this.options.onUncontrolledDialog)
        this.options.onUncontrolledDialog(dialog, page);
      else void dialog.respond(false).catch(() => {});
      return;
    }
    void (async () => {
      if (!permitted()) {
        await dialog.respond(false);
        return;
      }
      if (close.viewer.selected !== page.id)
        await this.select(close.viewer, page.id);
      if (!permitted()) {
        await dialog.respond(false);
        return;
      }
      close.dialog = dialog;
      close.id = randomBytes(18).toString('base64url');
      close.viewer.send({
        type: 'dialog',
        target: page.id,
        dialog: {
          id: close.id,
          type: 'beforeunload',
          authority: 'directory',
          url: dialog.url.slice(0, 8192),
          message: dialog.message.slice(0, 16000),
          defaultPrompt: '',
          truncated: dialog.message.length > 16000,
        },
      });
    })().catch(() => {
      void dialog.respond(false).catch(() => {});
    });
  }
  requestMediaKeyframe(scope: {
    target: string;
    view: string;
    stream: string;
  }): void {
    this.tabs.get(scope.target)?.engine.requestMediaKeyframe(scope);
  }
  async readResource(tab: string, id: string) {
    return this.tabs.get(tab)?.engine.resources.read(id);
  }
  private async readViewerResource(viewer: Viewer, tab: string, id: string) {
    const observation = viewer.observations.get(tab);
    const authorized = () =>
      viewer.active &&
      observation &&
      viewer.observations.get(tab) === observation &&
      this.entries(viewer).some((entry) => entry.page.id === tab);
    if (!authorized()) return;
    const resource = await this.tabs.get(tab)?.engine.resources.read(id);
    return authorized() ? resource : undefined;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.unsubscribe?.();
      for (const dispose of this.downloadTargets.values()) dispose();
      this.downloadTargets.clear();
      this.standalone?.dispose();
      for (const viewer of this.viewers) {
        viewer.active = false;
        viewer.authorize = undefined;
        viewer.directoryAuthorize = undefined;
        this.closeObservations(viewer);
      }
      const retirements = await Promise.allSettled(
        [...this.viewers].map(async (viewer) => {
          await viewer.queue;
          await this.drainRetirements(viewer);
        }),
      );
      this.viewers.clear();
      await Promise.allSettled(this.adding.values());
      const engines = await Promise.allSettled(
        [...this.tabs.values()].map(({ engine }) => engine.close()),
      );
      this.tabs.clear();
      const owners = await Promise.allSettled([this.owner?.dispose()]);
      const failures = [...retirements, ...engines, ...owners]
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(failures, 'Session source cleanup failed');
    })());
  }
}
