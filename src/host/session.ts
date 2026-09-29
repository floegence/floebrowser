import { randomBytes } from 'node:crypto';
import { MEDIA_WIRE_VERSION } from '../shared/media-wire.js';
import type { Page } from 'playwright';
import type { SourceDialog, SourcePage } from './source.js';
import {
  StandaloneSourceDirectory,
  type SourceDirectory,
  type DirectoryChange,
  type SourceTab,
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
  target: string;
  authorize: AttachOptions['authorize'];
  dialog?: SourceDialog;
  id?: string;
};
export interface SessionViewOptions extends ObservationOptions {
  initialTab?: string;
  /** External browser hosts can edit live tabs without granting URL restoration. */
  restoreClosedTabs?: boolean;
  /** Synchronous host grant predicate. Call refreshGrants after changing it. */
  canObserve?: (tab: SourceTab) => boolean;
  /** Independent per-source audio-output grant. Refresh after ownership changes. */
  canHear?: (page: SourcePage) => boolean;
}
type Viewer = {
  transfers: DownloadTransfers;
  id: string;
  active: boolean;
  selected: string;
  revision: number;
  selection: number;
  selections: Set<Promise<void>>;
  effects: Promise<void>;
  directoryWork: Promise<void>;
  send: (message: ServerMessage) => void;
  options: SessionViewOptions;
  visible: boolean;
  controller?: Controller;
  observation?: Observation;
  observations: Map<string, Observation>;
  observing: Map<string, Promise<Observation>>;
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
  /** Host-only selection used for a source-reported foreground popup. */
  select(tab: string): Promise<void>;
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
   * directory editing. Awaits only the current target's admission and returns
   * false if selection or authority changes, or another controller owns it. */
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
  private tabs = new Map<string, Tab>();
  private adding = new Map<string, Promise<Tab>>();
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
      this.directoryOrder = entries.map((entry) => entry.id);
      this.resumeTab = entries[0]?.id ?? '';
      if (this.standalone && this.resumeTab) await this.add(this.resumeTab);
    } catch (error) {
      this.unsubscribe();
      throw error;
    }
  }
  private entries(viewer?: Viewer) {
    const entries = this.directory
      .list()
      .filter(
        (entry) =>
          !viewer?.options.canObserve || viewer.options.canObserve(entry),
      );
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('Duplicate source target identity');
    return entries;
  }
  private directoryChanged(change: DirectoryChange): void {
    if (this.closing) return;
    const ids = this.entries().map((entry) => entry.id);
    const previous = this.directoryOrder;
    this.directoryOrder = ids;
    for (const id of this.tabs.keys())
      if (
        !this.entries().some((entry) => entry.id === id && !entry.availability)
      )
        this.drop(id);
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
    const ids = this.entries(viewer).map((entry) => entry.id);
    for (const close of this.directoryClosures.values())
      if (close.viewer === viewer && !ids.includes(close.target))
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
    if (
      next !== viewer.selected ||
      this.entries(viewer).find((entry) => entry.id === next)?.availability
    ) {
      this.retire(viewer);
      viewer.selected = next;
      ++viewer.revision;
      if (viewer === this.standaloneViewer) this.resumeTab = next;
      viewer.directoryWork = this.select(viewer, next);
    }
    this.publish(viewer);
    this.publishDownloads(viewer);
    // Grant publication and revocation cannot depend on a host resolving the
    // newly selected page. That resolver may need the same directory lock as
    // its caller, and a slow renderer must not hold metadata operations open.
    return this.drainRetirements(viewer);
  }
  private publishDownloads(viewer: Viewer): void {
    if (!viewer.active) return;
    for (const { id } of this.entries(viewer))
      viewer.send({
        type: 'downloads',
        target: id,
        items: this.directory.downloads(id).map((download) => ({
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
      tabs: this.entries(viewer).map(({ id, url, title, pinned, loading }) => {
        const state = this.tabs.get(id)?.engine.currentState;
        return {
          id,
          title: title ?? state?.title ?? '',
          url: state?.status === 'error' ? state.url : url,
          pinned: !!pinned,
          loading: loading ?? state?.loading ?? false,
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
  private add(id: string): Promise<Tab> {
    if (this.closing) return Promise.reject(new Error('Session closed'));
    const existing = this.tabs.get(id);
    if (existing && !existing.page.isClosed()) return Promise.resolve(existing);
    if (existing) this.drop(id);
    const pending = this.adding.get(id);
    if (pending) return pending;
    const entry = this.entries().find((entry) => entry.id === id);
    if (!entry || entry.availability)
      return Promise.reject(new Error('Source unavailable'));
    const task = (async () => {
      const page = await this.directory.resolve(id);
      if (
        page.id !== id ||
        page.isClosed() ||
        !this.entries().some((entry) => entry.id === id)
      )
        throw new Error('Source identity unavailable');
      let engine: BrowserProjection | undefined;
      engine = await BrowserProjection.attach(page, {
        ...this.options,
        onState: (state) => {
          this.options.onState?.(state);
          if (
            state.status === 'closed' &&
            engine &&
            this.tabs.get(id)?.engine === engine
          ) {
            this.drop(id);
            for (const viewer of this.viewers)
              if (viewer.selected === id) this.unavailable(viewer);
          } else this.publish();
        },
        onPopup: () => {}, // Only the directory owner can admit popups.
        onUncontrolledDialog: (dialog, source) =>
          this.directoryDialog(dialog, source),
      });
      if (
        this.closing ||
        page.isClosed() ||
        !this.entries().some((entry) => entry.id === page.id)
      ) {
        await engine.close();
        throw new Error('Source grant revoked while attaching a tab');
      }
      const tab = { page, engine };
      this.tabs.set(id, tab);
      this.publish();
      return tab;
    })().finally(() => this.adding.delete(id));
    this.adding.set(id, task);
    return task;
  }
  /** Trusted host entry point for AI control. Shares the exact same projection
   * and debugger as viewers; calling it does not grant input or observation. */
  async projection(id: string): Promise<BrowserProjection> {
    const entry = this.entries().find((entry) => entry.id === id);
    if (!entry) throw new Error('Unknown source target');
    return (await this.add(entry.id)).engine;
  }
  private unavailable(viewer: Viewer): void {
    if (viewer.active)
      viewer.send({
        type: 'projection',
        target: viewer.selected,
        status: 'unavailable',
      });
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
      this.entries(viewer).some((entry) => entry.id === tab.page.id);
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
    return true;
  }
  private select(viewer: Viewer, id: string): Promise<void> {
    const work = this.admitSelection(viewer, id);
    viewer.directoryWork = work;
    return work;
  }
  private async admitSelection(viewer: Viewer, id: string): Promise<void> {
    const entry = this.entries(viewer).find((entry) => entry.id === id);
    if (id && !entry) throw new Error('Unknown source tab');
    const selection = ++viewer.selection;
    this.retire(viewer);
    viewer.selected = id;
    if (viewer === this.standaloneViewer) this.resumeTab = id;
    this.publish(viewer);
    const current = () =>
      viewer.active && viewer.selection === selection && !this.closing;
    if (!entry || entry.availability) {
      viewer.send({
        type: 'projection',
        target: id,
        status: entry ? 'unsupported' : 'empty',
      });
      return;
    }
    viewer.send({ type: 'projection', target: id, status: 'loading' });
    try {
      const tab = await this.add(id);
      if (!current()) return;
      // Selecting a projection never activates the physical browser tab.
      let pending = viewer.observing.get(id);
      if (!viewer.observations.has(id) && !pending) {
        pending = tab.engine
          .observe(
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
                  (this.entries(viewer).some((entry) => entry.id === id) &&
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
                      this.entries(viewer).some((entry) => entry.id === id) &&
                      (frame.header.track !== 'audio' ||
                        this.canHear(viewer, id))
                    )
                      viewer.options.onMediaFrame?.(frame);
                  }
                : undefined,
            },
          )
          .then(async (observation) => {
            if (
              !viewer.active ||
              this.tabs.get(id) !== tab ||
              !this.entries(viewer).some((entry) => entry.id === id)
            ) {
              await observation.close();
              throw new Error('Observation grant revoked');
            }
            viewer.observations.set(id, observation);
            return observation;
          })
          .finally(() => viewer.observing.delete(id));
        viewer.observing.set(id, pending);
      }
      const observation = viewer.observations.get(id) ?? (await pending!);
      if (!current()) {
        this.trackRetirement(viewer, observation.setVisible(false));
        return;
      }
      this.trackRetirement(viewer, observation.setVisible(viewer.visible));
      viewer.observation = observation;
      await this.control(viewer);
      if (current())
        viewer.send({ type: 'projection', target: id, status: 'ready' });
    } catch {
      if (current()) this.unavailable(viewer);
    }
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
    this.tabs.delete(id);
    void tab.engine.close();
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
      selection: 0,
      selections: new Set(),
      effects: Promise.resolve(),
      directoryWork: Promise.resolve(),
      send,
      options: { ...options },
      visible: options.visible !== false,
      observations: new Map(),
      observing: new Map(),
      mediaEnabled: options.media !== false,
      lastID: 0,
      pending: 0,
      retiring: new Map(),
    };
    const entries = this.entries(viewer);
    viewer.selected =
      entries.find(
        (entry) => entry.id === (options.initialTab ?? this.resumeTab),
      )?.id ??
      entries[0]?.id ??
      '';
    this.viewers.add(viewer);
    try {
      send({
        type: 'hello',
        version: PROTOCOL_VERSION,
        mediaWireVersion: MEDIA_WIRE_VERSION,
      });
      send({ type: 'session_access', editTabs: false });
      await this.select(viewer, viewer.selected);
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
      select: (tab) => {
        if (
          !viewer.active ||
          !this.entries(viewer).some((entry) => entry.id === tab)
        )
          return Promise.reject(new Error('Unknown source tab'));
        return this.select(viewer, tab);
      },
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
          !this.entries(viewer).some((entry) => entry.id === viewer.selected)
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
        send({
          type: 'session_access',
          editTabs: Boolean(authorize),
          restoreTabs:
            Boolean(authorize) && viewer.options.restoreClosedTabs !== false,
        });
      },
      acquireControl: async (authorize, canControl) => {
        if (!viewer.active) return false;
        const selected = viewer.selected;
        const selection = viewer.selection;
        const admission = viewer.directoryWork;
        const previous = viewer.controller;
        const grant =
          canControl ?? ((page: SourcePage) => page.id === selected);
        viewer.controller = undefined;
        viewer.authorize = authorize;
        viewer.canControl = grant;
        if (previous) await previous.close();
        await admission;
        if (
          viewer.selection !== selection ||
          viewer.authorize !== authorize ||
          viewer.canControl !== grant
        )
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
        const page = {
          id: tab,
          downloads: () => this.directory.downloads(tab),
          isClosed: () => !this.entries().some((entry) => entry.id === tab),
        };
        const authorized = () =>
          viewer.active &&
          this.entries(viewer).some((entry) => entry.id === tab);
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
          await Promise.allSettled(viewer.selections);
          await viewer.effects;
          await Promise.allSettled(viewer.observing.values());
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
      !this.entries(viewer).some((entry) => entry.id === viewer.selected)
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
    const explicitTarget = ['tab_select', 'tab_retry', 'tab_close'].includes(
      message.action.kind,
    );
    if (!explicitTarget && message.tab !== viewer.selected) {
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
          !this.entries(viewer).some((entry) => entry.id === closing.target)
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
    if (
      (!viewer.directoryAuthorize &&
        !['tab_select', 'tab_retry'].includes(message.action.kind)) ||
      (message.action.kind === 'tab_restore' &&
        viewer.options.restoreClosedTabs === false)
    ) {
      ack('not_allowed');
      return Promise.resolve();
    }
    if (viewer.pending >= MAX_PENDING_COMMANDS) {
      ack('busy');
      return Promise.resolve();
    }
    const selecting = ['tab_select', 'tab_retry'].includes(message.action.kind);
    const revision =
      selecting || ['tab_new', 'tab_restore'].includes(message.action.kind)
        ? ++viewer.revision
        : viewer.revision;
    viewer.pending++;
    let operation: Promise<void> | undefined;
    const admit = async () => {
      if (!viewer.active) return;
      if (!explicitTarget && message.tab !== viewer.selected) {
        ack('stale_view');
        return;
      }
      const action = message.action,
        authorize = viewer.directoryAuthorize;
      if (
        (!['tab_select', 'tab_retry'].includes(action.kind) && !authorize) ||
        (authorize && !(await authorize(action)))
      ) {
        ack('not_allowed');
        return;
      }
      if (
        !viewer.active ||
        (selecting && revision !== viewer.revision) ||
        (!explicitTarget && message.tab !== viewer.selected) ||
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
          const target =
            action.kind === 'tab_new'
              ? await this.directory.create()
              : await this.directory.restore();
          if (target && viewer.active && revision === viewer.revision)
            viewer.directoryWork = this.select(viewer, target);
        } else if ('tab' in action) {
          const ids = this.entries(viewer).map((entry) => entry.id);
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
          else if (action.kind === 'tab_select' || action.kind === 'tab_retry')
            viewer.directoryWork = this.select(viewer, action.tab);
          else if (action.kind === 'tab_close') {
            if (this.directoryClosures.has(action.tab)) {
              ack('busy');
              return;
            }
            const closing: DirectoryClose = {
              viewer,
              target: action.tab,
              authorize: authorize!,
            };
            this.directoryClosures.set(action.tab, closing);
            try {
              await this.directory.close(action.tab);
            } finally {
              await this.dismissDirectoryDialog(closing);
              this.directoryClosures.delete(action.tab);
            }
          }
        }
        ack();
      })();
      void operation.catch(() => {});
      // Native mutations keep receive order. Page acquisition is independent
      // and reports loading/failure separately from confirmed directory effects.
      if (!['tab_select', 'tab_retry'].includes(action.kind)) await operation;
    };
    let admission: Promise<void>;
    if (selecting) {
      admission = admit();
      viewer.selections.add(admission);
      void admission
        .finally(() => viewer.selections.delete(admission))
        .catch(() => {});
    } else {
      admission = viewer.effects.then(admit);
      viewer.effects = admission.catch(() => {});
    }
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
          target: close.target,
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
      this.entries(close.viewer).some((entry) => entry.id === page.id);
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
      this.entries(viewer).some((entry) => entry.id === tab);
    if (!authorized()) return;
    const resource = await this.tabs.get(tab)?.engine.resources.read(id);
    return authorized() ? resource : undefined;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.unsubscribe?.();
      this.standalone?.dispose();
      for (const viewer of this.viewers) {
        viewer.active = false;
        viewer.authorize = undefined;
        viewer.directoryAuthorize = undefined;
        this.closeObservations(viewer);
      }
      const retirements = await Promise.allSettled(
        [...this.viewers].map(async (viewer) => {
          await Promise.allSettled(viewer.selections);
          await viewer.effects;
          await Promise.allSettled(viewer.observing.values());
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
