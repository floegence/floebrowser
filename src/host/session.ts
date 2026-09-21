import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import type { SourcePage } from './source.js';
import {
  StandaloneSourceDirectory,
  type SourceDirectory,
  type DirectoryChange,
} from './directory.js';
import { PlaywrightSourceBrowser } from './playwright-source.js';
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
} from '../shared/protocol.js';

type Tab = { page: SourcePage; engine: BrowserProjection };
export interface SessionViewOptions extends ObservationOptions {
  initialTab?: string;
  /** Synchronous host grant predicate. Call refreshGrants after changing it. */
  canObserve?: (page: SourcePage) => boolean;
}
type Viewer = {
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
  mediaEnabled: boolean;
  lastID: number;
  pending: number;
  retiring: Set<Promise<void>>;
};
export interface SessionConnection extends Controller {
  readonly id: string;
  readonly currentState: TabState;
  setMedia(enabled: boolean): Promise<void>;
  setAudio(enabled: boolean): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  /** Host-only grant. Returns false when the selected source has another owner;
   * it never steals user/AI control. Authorized directory operations remain usable. */
  acquireControl(authorize: AttachOptions['authorize']): Promise<boolean>;
  releaseControl(): Promise<void>;
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
  private adding = new Map<SourcePage, Promise<Tab>>();
  private viewers = new Set<Viewer>();
  private standaloneViewer?: Viewer;
  private resumeTab = '';
  private directoryOrder: string[] = [];
  private unsubscribe?: () => void;
  private closing?: Promise<void>;
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
      this.directoryOrder = entries.map((entry) => entry.page.id);
      if (entries[0]) {
        await this.add(entries[0].page);
        this.resumeTab = entries[0].page.id;
      }
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
    const ids = this.entries().map((entry) => entry.page.id);
    const previous = this.directoryOrder;
    this.directoryOrder = ids;
    for (const id of this.tabs.keys()) if (!ids.includes(id)) this.drop(id);
    for (const viewer of this.viewers)
      void this.refreshGrants(viewer, change, previous);
    if (!ids.includes(this.resumeTab)) this.resumeTab = ids[0] ?? '';
  }
  private refreshGrants(
    viewer: Viewer,
    change: DirectoryChange = {},
    previous = this.directoryOrder,
  ): Promise<void> {
    if (!viewer.active) return Promise.resolve();
    const ids = this.entries(viewer).map((entry) => entry.page.id);
    for (const [id, observation] of viewer.observations)
      if (!ids.includes(id)) {
        viewer.observations.delete(id);
        if (viewer.observation === observation) this.retire(viewer);
        this.trackRetirement(viewer, observation.close());
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
    return viewer.directoryWork;
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
  private trackRetirement(viewer: Viewer, work: Promise<void>): void {
    viewer.retiring.add(work);
    void work.finally(() => viewer.retiring.delete(work)).catch(() => {});
  }
  private retire(viewer: Viewer): void {
    const observation = viewer.observation;
    viewer.controller = undefined;
    viewer.observation = undefined;
    if (observation)
      this.trackRetirement(viewer, observation.setVisible(false));
  }
  private closeObservations(viewer: Viewer): void {
    viewer.controller = undefined;
    viewer.observation = undefined;
    for (const observation of viewer.observations.values())
      this.trackRetirement(viewer, observation.close());
    viewer.observations.clear();
  }
  private async control(viewer: Viewer): Promise<boolean> {
    const observation = viewer.observation,
      tab = this.tabs.get(viewer.selected),
      authorize = viewer.authorize;
    if (!viewer.active || !viewer.visible || !observation || !tab || !authorize)
      return false;
    if (viewer.controller) return true;
    if (tab.engine.hasController) return false;
    const admitted = () =>
      viewer.active &&
      viewer.visible &&
      viewer.observation === observation &&
      viewer.authorize === authorize &&
      this.entries(viewer).some((entry) => entry.page === tab.page);
    const controller = await tab.engine.acquireControl(
      observation,
      authorize,
      admitted,
    );
    if (
      !viewer.active ||
      viewer.observation !== observation ||
      viewer.authorize !== authorize
    ) {
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
          visible: viewer.visible,
          onMediaFrame: viewer.options.onMediaFrame
            ? (frame) => {
                if (
                  viewer.active &&
                  this.entries(viewer).some((entry) => entry.page.id === id)
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
      retiring: new Set(),
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
        send({ type: 'hello', version: PROTOCOL_VERSION, mediaWireVersion: 1 });
        this.publish(viewer);
      }
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
          [...viewer.observations.values()].map((observation) =>
            observation.setAudio(enabled),
          ),
        );
      },
      setVisible: async (visible) => {
        if (!viewer.active || viewer.visible === visible) return;
        viewer.visible = visible;
        if (!visible) this.retire(viewer);
        else if (viewer.selected) await this.select(viewer, viewer.selected);
      },
      acquireControl: async (authorize) => {
        if (!viewer.active) return false;
        viewer.authorize = authorize;
        send({ type: 'session_access', editTabs: true });
        return this.control(viewer);
      },
      releaseControl: () => {
        viewer.authorize = undefined;
        if (viewer.active) send({ type: 'session_access', editTabs: false });
        const control = viewer.controller;
        viewer.controller = undefined;
        return control?.close() ?? Promise.resolve();
      },
      refreshGrants: () => this.refreshGrants(viewer),
      readResource: (tab, id) => this.readViewerResource(viewer, tab, id),
      close: () =>
        (closed ??= (async () => {
          viewer.active = false;
          viewer.authorize = undefined;
          this.closeObservations(viewer);
          this.viewers.delete(viewer);
          await viewer.queue;
          await Promise.all(viewer.retiring);
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
    await connection.acquireControl(this.options.authorize);
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
      void this.refreshGrants(viewer);
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
    if (!message.action.kind.startsWith('tab_')) {
      if (viewer.controller) return viewer.controller.receive(message);
      ack('not_allowed');
      return Promise.resolve();
    }
    if (!viewer.authorize && message.action.kind !== 'tab_select') {
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
        authorize = viewer.authorize;
      if (authorize && !(await authorize(action))) {
        ack('not_allowed');
        return;
      }
      if (
        !viewer.active ||
        message.tab !== viewer.selected ||
        viewer.authorize !== authorize
      ) {
        if (viewer.active)
          ack(viewer.authorize !== authorize ? 'not_allowed' : 'stale_view');
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
            await this.directory.close(action.tab);
            await viewer.directoryWork;
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
      this.standalone?.dispose();
      for (const viewer of this.viewers) {
        viewer.active = false;
        viewer.authorize = undefined;
        this.closeObservations(viewer);
      }
      await Promise.all(
        [...this.viewers].flatMap((viewer) => [
          viewer.queue,
          ...viewer.retiring,
        ]),
      );
      this.viewers.clear();
      await Promise.allSettled(this.adding.values());
      await Promise.all(
        [...this.tabs.values()].map(({ engine }) => engine.close()),
      );
      this.tabs.clear();
      await this.owner?.dispose();
    })());
  }
}
