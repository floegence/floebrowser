import type { Page } from 'playwright';
import {
  BrowserProjection,
  type AttachOptions,
  type Controller,
} from './engine.js';
import {
  clientMessageSchema,
  MAX_PENDING_COMMANDS,
  type ClientMessage,
  type ServerMessage,
  type TabState,
} from '../shared/protocol.js';

type Tab = { page: Page; engine: BrowserProjection };
type Viewer = {
  active: boolean;
  send: (message: ServerMessage) => void;
  controller?: Controller;
  lastID: number;
  pending: number;
};

/** Owns one initial page, its popups and explicitly created tabs; never adopts unrelated pages. */
export class BrowserSession {
  private tabs = new Map<string, Tab>();
  private adding = new Map<Page, Promise<Tab>>();
  private selected = '';
  private viewer?: Viewer;
  private queue = Promise.resolve();
  private closing?: Promise<void>;
  private constructor(
    private initial: Page,
    private options: AttachOptions,
  ) {}

  static async attach(
    page: Page,
    options: AttachOptions,
  ): Promise<BrowserSession> {
    const session = new BrowserSession(page, options);
    const tab = await session.add(page);
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
  private add(page: Page): Promise<Tab> {
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
          if (!this.closing)
            void this.enqueue(async () => {
              const tab = await this.add(popup);
              await this.select(tab.engine.id);
            }).catch(() => this.unavailable());
        },
      });
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
      message:
        'The source tab could not be opened. Try again from the current tab.',
    });
  }
  private async select(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab || tab.page.isClosed()) throw new Error('Unknown source tab');
    const viewer = this.viewer;
    await viewer?.controller?.close();
    if (viewer) viewer.controller = undefined;
    this.selected = id;
    this.publish();
    await tab.page.bringToFront();
    if (viewer?.active) {
      viewer.controller = await tab.engine.connect((message) => {
        if (
          viewer.active &&
          this.viewer === viewer &&
          this.selected === id &&
          !(message.type === 'state' && message.state.status === 'closed')
        )
          viewer.send(message);
      });
      if (!viewer.active) await viewer.controller.close();
    }
  }
  private async remove(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const ids = [...this.tabs.keys()];
    const index = ids.indexOf(id);
    if (this.selected === id) await this.viewer?.controller?.close();
    await tab.engine.close();
    this.tabs.delete(id);
    if (this.selected === id && !this.closing) {
      const next = ids[index + 1] ?? ids[index - 1];
      if (next) await this.select(next);
      else {
        const fresh = await this.add(await this.initial.context().newPage());
        await this.select(fresh.engine.id);
      }
    }
    this.publish();
  }
  async connect(send: (message: ServerMessage) => void): Promise<Controller> {
    if (this.hasController || this.closing)
      throw new Error('Session unavailable');
    await this.queue;
    if (this.hasController || this.closing)
      throw new Error('Session unavailable');
    const viewer: Viewer = { active: true, send, lastID: 0, pending: 0 };
    this.viewer = viewer;
    try {
      await this.select(this.selected);
    } catch (error) {
      viewer.active = false;
      this.viewer = undefined;
      throw error;
    }
    let closed: Promise<void> | undefined;
    return {
      receive: (message) => this.receive(viewer, message),
      close: () => {
        closed ??= (async () => {
          viewer.active = false;
          await viewer.controller?.close();
          await this.queue;
          if (this.viewer === viewer) this.viewer = undefined;
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
    if (message.type === 'media_answer') {
      if (message.tab !== this.selected) return Promise.resolve();
      return viewer.controller?.receive(message) ?? Promise.resolve();
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
    if (viewer.pending >= MAX_PENDING_COMMANDS) {
      ack('busy');
      return Promise.resolve();
    }
    viewer.pending++;
    return this.enqueue(async () => {
      try {
        if (!viewer.active) return;
        if (message.tab !== this.selected) {
          ack('stale_view');
          return;
        }
        const action = message.action;
        if (!action.kind.startsWith('tab_')) {
          if (viewer.controller) await viewer.controller.receive(message);
          else ack('action_failed');
          return;
        }
        if (!(await this.options.authorize(action))) {
          ack('not_allowed');
          return;
        }
        if (!viewer.active || message.tab !== this.selected) return;
        if (action.kind === 'tab_new') {
          const tab = await this.add(await this.initial.context().newPage());
          await this.select(tab.engine.id);
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
      } catch {
        ack('action_failed');
      } finally {
        viewer.pending--;
      }
    });
  }
  async readResource(tab: string, id: string) {
    return this.tabs.get(tab)?.engine.resources.read(id);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.viewer) {
        this.viewer.active = false;
        await this.viewer.controller?.close();
      }
      await this.queue;
      await Promise.all(this.adding.values());
      await Promise.all(
        [...this.tabs.values()].map(({ engine }) => engine.close()),
      );
      this.tabs.clear();
    })());
  }
}
