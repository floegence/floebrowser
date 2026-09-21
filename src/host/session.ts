import type { Page } from 'playwright';
import type { SourcePage } from './source.js';
import { PlaywrightSourceBrowser } from './playwright-source.js';
import {
  BrowserProjection,
  type AttachOptions,
  type Controller,
  type Observation,
} from './engine.js';
import {
  clientMessageSchema,
  MAX_PENDING_COMMANDS,
  type ClientMessage,
  type ServerMessage,
  type TabState,
} from '../shared/protocol.js';

type Tab = { page: SourcePage; engine: BrowserProjection };
type Viewer = {
  active: boolean;
  send: (message: ServerMessage) => void;
  controller?: Controller;
  observation?: Observation;
  observations: Map<string, Observation>;
  mediaEnabled: boolean;
  lastID: number;
  pending: number;
  retiring: Set<Promise<void>>;
};
export interface SessionConnection extends Controller {
  setMedia(enabled: boolean): Promise<void>;
}

/** Owns one initial page, its popups and explicitly created tabs; never adopts unrelated pages. */
export class BrowserSession {
  private tabs = new Map<string, Tab>();
  private adding = new Map<SourcePage, Promise<Tab>>();
  private selected = '';
  private selectionRevision = 0;
  private viewer?: Viewer;
  private queue = Promise.resolve();
  private closing?: Promise<void>;
  private constructor(
    private initial: SourcePage,
    private options: AttachOptions,
    private owner?: PlaywrightSourceBrowser,
  ) {}

  static async attach(
    page: Page | SourcePage,
    options: AttachOptions,
  ): Promise<BrowserSession> {
    const owner =
      'transport' in page ? undefined : new PlaywrightSourceBrowser();
    const source = 'transport' in page ? page : await owner!.adopt(page);
    const session = new BrowserSession(source, options, owner);
    let tab: Tab;
    try {
      tab = await session.add(source);
    } catch (error) {
      await owner?.dispose();
      throw error;
    }
    session.selected = tab.engine.id;
    return session;
  }
  get activeProjection(): BrowserProjection {
    return this.tabs.get(this.selected)!.engine;
  }
  get hasController(): boolean {
    return !!this.viewer?.active;
  }
  get currentState(): TabState {
    return {
      active: this.selected,
      tabs: [...this.tabs.values()].map(({ engine }) => {
        const { id, title, url } = engine.currentState;
        return { id, title, url };
      }),
    };
  }
  private send(message: ServerMessage): void {
    if (this.viewer?.active) this.viewer.send(message);
  }
  private publish(): void {
    this.send({ type: 'tabs', state: this.currentState });
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  private add(page: SourcePage): Promise<Tab> {
    if (this.closing) return Promise.reject(new Error('Session closed'));
    const existing = [...this.tabs.values()].find((tab) => tab.page === page);
    if (existing) return Promise.resolve(existing);
    const pending = this.adding.get(page);
    if (pending) return pending;
    const task = (async () => {
      const engine = await BrowserProjection.attach(page, {
        ...this.options,
        onState: (state) => {
          this.options.onState?.(state);
          if (state.status === 'closed' && !this.closing) {
            void this.enqueue(() => this.remove(state.id)).catch(() =>
              this.unavailable(),
            );
          } else this.publish();
        },
        onPopup: (popup) => {
          if (this.closing) return;
          const revision = ++this.selectionRevision;
          // Attaching a popup may wait on its renderer. It never occupies the
          // session's admission queue or overrides a later explicit selection.
          void this.add(popup)
            .then((tab) =>
              this.enqueue(async () => {
                if (!this.closing && revision === this.selectionRevision)
                  await this.select(tab.engine.id);
              }),
            )
            .catch(() => this.unavailable());
        },
      });
      if (this.closing) {
        await engine.close();
        throw new Error('Session closed while attaching a tab');
      }
      const tab = { page, engine };
      this.tabs.set(engine.id, tab);
      this.publish();
      return tab;
    })().finally(() => this.adding.delete(page));
    this.adding.set(page, task);
    return task;
  }
  private unavailable(): void {
    this.send({
      type: 'notice',
      code: 'tab_unavailable',
    });
  }
  private trackRetirement(viewer: Viewer, work: Promise<void>): void {
    viewer.retiring.add(work);
    void work.finally(() => viewer.retiring.delete(work)).catch(() => {});
  }
  private retire(viewer?: Viewer): void {
    if (!viewer) return;
    const observation = viewer.observation;
    viewer.controller = undefined;
    viewer.observation = undefined;
    // Hiding revokes input synchronously, but preserves an authorized audio
    // subscription. Renderer cleanup never delays a different source target.
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
  private async select(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab || tab.page.isClosed()) throw new Error('Unknown source tab');
    const viewer = this.viewer;
    // close() revokes synchronously. Its renderer cleanup belongs to the old
    // projection and must not delay admission to an unrelated source page.
    this.retire(viewer);
    this.selected = id;
    this.publish();
    void tab.page.bringToFront().catch(() => {});
    if (viewer?.active) {
      const observation =
        viewer.observations.get(id) ??
        (await tab.engine.observe(
          (message) => {
            if (
              viewer.active &&
              this.viewer === viewer &&
              (message.type === 'media' ||
                message.type === 'media_end' ||
                (this.selected === id &&
                  !(
                    message.type === 'state' &&
                    message.state.status === 'closed'
                  )))
            )
              viewer.send(message);
          },
          { ...this.options, media: viewer.mediaEnabled },
        ));
      if (!viewer.active) {
        await observation.close();
        return;
      }
      viewer.observations.set(id, observation);
      if (this.selected !== id) {
        this.trackRetirement(viewer, observation.setVisible(false));
        return;
      }
      this.trackRetirement(viewer, observation.setVisible(true));
      viewer.observation = observation;
      try {
        const controller = await tab.engine.acquireControl(
          observation,
          this.options.authorize,
        );
        if (
          !viewer.active ||
          viewer.observation !== observation ||
          this.selected !== id
        )
          this.trackRetirement(viewer, observation.setVisible(false));
        else viewer.controller = controller;
      } catch (error) {
        this.trackRetirement(viewer, observation.setVisible(false));
        if (viewer.observation === observation) viewer.observation = undefined;
        throw error;
      }
    }
  }
  private async remove(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const ids = [...this.tabs.keys()];
    const index = ids.indexOf(id);
    if (this.selected === id) this.retire(this.viewer);
    const observation = this.viewer?.observations.get(id);
    this.viewer?.observations.delete(id);
    if (observation && this.viewer)
      this.trackRetirement(this.viewer, observation.close());
    void tab.engine.close();
    this.tabs.delete(id);
    if (this.selected === id && !this.closing) {
      const next = ids[index + 1] ?? ids[index - 1];
      if (next) await this.select(next);
      else {
        const fresh = await this.add(await this.initial.createPage());
        await this.select(fresh.engine.id);
      }
    }
    this.publish();
  }
  async connect(
    send: (message: ServerMessage) => void,
    options: { media?: boolean } = {},
  ): Promise<SessionConnection> {
    if (this.hasController || this.closing)
      throw new Error('Session unavailable');
    await this.queue;
    if (this.hasController || this.closing)
      throw new Error('Session unavailable');
    const viewer: Viewer = {
      active: true,
      send,
      lastID: 0,
      pending: 0,
      retiring: new Set(),
      observations: new Map(),
      mediaEnabled: options.media !== false,
    };
    this.viewer = viewer;
    try {
      await this.select(this.selected);
    } catch (error) {
      viewer.active = false;
      this.closeObservations(viewer);
      this.viewer = undefined;
      throw error;
    }
    let closed: Promise<void> | undefined;
    return {
      receive: (message) => this.receive(viewer, message),
      setMedia: async (enabled) => {
        if (!viewer.active) return;
        viewer.mediaEnabled = enabled;
        await Promise.all(
          [...viewer.observations.values()].map((observation) =>
            observation.setMedia(enabled),
          ),
        );
      },
      close: () => {
        closed ??= (async () => {
          viewer.active = false;
          this.closeObservations(viewer);
          await this.queue;
          if (this.viewer === viewer) this.viewer = undefined;
          await Promise.all(viewer.retiring);
        })();
        return closed;
      },
    };
  }
  private receive(viewer: Viewer, input: ClientMessage): Promise<void> {
    if (!viewer.active || this.viewer !== viewer) return Promise.resolve();
    const parsed = clientMessageSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve();
    const message = parsed.data;
    if (message.type === 'media_keyframe') {
      return (
        viewer.observations.get(message.tab)?.receive(message) ??
        Promise.resolve()
      );
    }
    if (message.type === 'resync')
      return viewer.controller?.receive(message) ?? Promise.resolve();
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
    if (!message.action.kind.startsWith('tab_')) {
      if (message.tab !== this.selected) ack('stale_view');
      else if (viewer.controller) return viewer.controller.receive(message);
      else ack('action_failed');
      return Promise.resolve();
    }
    if (viewer.pending >= MAX_PENDING_COMMANDS) {
      ack('busy');
      return Promise.resolve();
    }
    if (message.tab !== this.selected) {
      ack('stale_view');
      return Promise.resolve();
    }
    const revision =
      message.action.kind === 'tab_move'
        ? this.selectionRevision
        : ++this.selectionRevision;
    viewer.pending++;
    let operation: Promise<void> | undefined;
    const admission = this.enqueue(async () => {
      if (!viewer.active) return;
      if (message.tab !== this.selected) {
        ack('stale_view');
        return;
      }
      const action = message.action;
      if (!(await this.options.authorize(action))) {
        ack('not_allowed');
        return;
      }
      if (!viewer.active || message.tab !== this.selected) return;
      operation = (async () => {
        if (action.kind === 'tab_new') {
          const tab = await this.add(await this.initial.createPage());
          if (viewer.active && revision === this.selectionRevision)
            await this.select(tab.engine.id);
        } else if (action.kind === 'tab_move') {
          if (
            !this.tabs.has(action.tab) ||
            (action.before !== null && !this.tabs.has(action.before))
          ) {
            ack('stale_view');
            return;
          }
          if (action.tab !== action.before) {
            const entries = [...this.tabs].filter(([id]) => id !== action.tab);
            const index =
              action.before === null
                ? entries.length
                : entries.findIndex(([id]) => id === action.before);
            entries.splice(index, 0, [action.tab, this.tabs.get(action.tab)!]);
            this.tabs = new Map(entries);
            this.publish();
          }
        } else if (action.kind === 'tab_select') await this.select(action.tab);
        else if (action.kind === 'tab_close') {
          const tab = this.tabs.get(action.tab);
          if (!tab) {
            ack('stale_view');
            return;
          }
          await tab.page.close();
          await this.remove(action.tab);
        }
        ack();
      })();
      // Observe immediately, even while the admission promise is settling.
      void operation.catch(() => {});
    });
    return admission
      .then(() => operation)
      .catch(() => {
        ack('action_failed');
      })
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
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.viewer) {
        this.viewer.active = false;
        this.closeObservations(this.viewer);
        await Promise.all(this.viewer.retiring);
      }
      await this.queue;
      await Promise.allSettled(this.adding.values());
      await Promise.all(
        [...this.tabs.values()].map(({ engine }) => engine.close()),
      );
      this.tabs.clear();
      await this.owner?.dispose();
    })());
  }
}
