import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EventType, type eventWithTime } from '@rrweb/types';
import type { Page, CDPSession } from 'playwright';
import {
  clientMessageSchema,
  focusSchema,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_COMMANDS,
  PROTOCOL_VERSION,
  type Action,
  type BrowserState,
  type ClientMessage,
  type Command,
  type ServerMessage,
} from '../shared/protocol.js';
import { DOMProjection } from './projection.js';
import { ResourceStore } from './resources.js';

const attachedPages = new WeakSet<Page>();

export interface AttachOptions {
  /** Called immediately before dispatch. The embedding host remains the authority. */
  authorize: (action: Action) => boolean | Promise<boolean>;
  /** Resolves an opaque resource ID through the host's authorized carrier. */
  resourceURL?: (id: string) => string;
}
export interface Controller {
  receive(message: ClientMessage): Promise<void>;
  close(): Promise<void>;
}
type Viewer = {
  send: (message: ServerMessage) => void;
  active: boolean;
  lastID: number;
  pending: number;
  resyncPending: boolean;
};

/** One page, one projection, one controller. Does not own the browser or profile. */
export class BrowserProjection {
  readonly resources: ResourceStore;
  private projection: DOMProjection;
  private binding = `floe_emit_${randomBytes(12).toString('hex')}`;
  private recorderKey = `__floe_${randomBytes(12).toString('hex')}`;
  private scriptID = '';
  private contextID = 0;
  private mainFrameID = '';
  private generation = 0;
  private epoch = '';
  private sequence = 0;
  private metadata?: eventWithTime;
  private viewer?: Viewer;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private controlFault = false;
  private closing?: Promise<void>;
  private snapshotPending = false;
  private heldKeys = new Map<string, Record<string, unknown>>();
  private heldButtons = new Set<string>();
  private state: BrowserState;
  private disposers: Array<() => void> = [];

  private constructor(
    private page: Page,
    private cdp: CDPSession,
    private options: AttachOptions,
  ) {
    this.resources = new ResourceStore(
      cdp,
      (message) => this.send({ type: 'notice', message }),
      options.resourceURL,
    );
    this.projection = new DOMProjection(this.resources);
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    this.state = {
      url: page.url(),
      title: '',
      status: 'loading',
      canGoBack: false,
      canGoForward: false,
      ...viewport,
    };
  }

  static async attach(
    page: Page,
    options: AttachOptions,
  ): Promise<BrowserProjection> {
    if (attachedPages.has(page))
      throw new Error('This page already has a FloeBrowser projection.');
    attachedPages.add(page);
    let engine: BrowserProjection | undefined;
    try {
      const cdp = await page.context().newCDPSession(page);
      engine = new BrowserProjection(page, cdp, options);
      await engine.initialize();
      return engine;
    } catch (error) {
      await engine?.close();
      attachedPages.delete(page);
      throw error;
    }
  }

  get hasController(): boolean {
    return !!this.viewer?.active;
  }
  get currentState(): BrowserState {
    return { ...this.state };
  }

  private listen(
    emitter: any,
    event: string,
    handler: (...args: any[]) => void,
  ): void {
    emitter.on(event, handler);
    this.disposers.push(() => emitter.off(event, handler));
  }

  private async initialize(): Promise<void> {
    this.mainFrameID = (
      await this.cdp.send('Page.getFrameTree')
    ).frameTree.frame.id;
    this.listen(this.cdp, 'Runtime.executionContextCreated', ({ context }) => {
      if (
        context.auxData?.isDefault &&
        context.auxData.frameId === this.mainFrameID
      ) {
        this.contextID = context.id;
        this.epoch = '';
        this.metadata = undefined;
        this.updateState({ status: 'loading' });
      }
    });
    this.listen(this.cdp, 'Runtime.executionContextsCleared', () => {
      this.contextID = 0;
      this.epoch = '';
      this.metadata = undefined;
      this.heldKeys.clear();
      this.heldButtons.clear();
      this.updateState({ status: 'loading' });
    });
    this.listen(this.cdp, 'Runtime.bindingCalled', (event) => {
      if (
        event.name !== this.binding ||
        event.executionContextId !== this.contextID ||
        this.closed
      )
        return;
      if (Buffer.byteLength(event.payload) > MAX_MESSAGE_BYTES) {
        this.send({
          type: 'notice',
          message: 'This page exceeds the DOM snapshot limit.',
        });
        return;
      }
      try {
        this.recorded(JSON.parse(event.payload));
      } catch {
        this.send({
          type: 'notice',
          message:
            'A page update could not be projected. Reconnect to refresh the view.',
        });
      }
    });
    this.listen(this.page, 'framenavigated', (frame) => {
      if (frame === this.page.mainFrame()) {
        this.updateState({ url: frame.url() });
        void this.refreshState();
      }
    });
    this.listen(this.page, 'domcontentloaded', () => {
      void this.refreshState();
    });
    this.listen(this.page, 'load', () => {
      void this.refreshState();
    });
    this.listen(this.page, 'close', () => {
      this.updateState({ status: 'closed' });
      void this.close();
    });
    this.listen(this.page, 'popup', () =>
      this.send({
        type: 'notice',
        message:
          'The website opened another source tab. Additional tabs are not projected in this version.',
      }),
    );
    this.listen(this.page, 'dialog', (dialog) => {
      this.send({
        type: 'notice',
        message:
          'A browser dialog was dismissed. Native dialogs are not supported in DOM mode.',
      });
      void dialog.dismiss().catch(() => {});
    });
    this.listen(this.page, 'download', () =>
      this.send({
        type: 'notice',
        message:
          'The download was started in the source browser. File transfer is not available in this version.',
      }),
    );
    await this.resources.start(this.mainFrameID);
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Runtime.addBinding', { name: this.binding });
    const code = await readFile(
      new URL('../assets/recorder.js', import.meta.url),
      'utf8',
    );
    const script = `${code}\nFloeRecorder.installRecorder(${JSON.stringify(this.binding)},${JSON.stringify(this.recorderKey)});`;
    this.scriptID = (
      await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: script,
      })
    ).identifier;
    await this.cdp.send('Runtime.evaluate', {
      expression: script,
      contextId: this.contextID,
    });
    await this.refreshState();
  }

  private async refreshState(): Promise<void> {
    if (this.closed) return;
    const title = await this.page.title().catch(() => '');
    const history = await this.cdp
      .send('Page.getNavigationHistory')
      .catch(() => undefined);
    if (!this.closed)
      this.updateState({
        url: this.page.url(),
        title,
        canGoBack: !!history && history.currentIndex > 0,
        canGoForward:
          !!history && history.currentIndex < history.entries.length - 1,
        status: this.epoch ? 'ready' : 'loading',
      });
  }
  private updateState(state: Partial<BrowserState>): void {
    this.state = { ...this.state, ...state };
    this.send({ type: 'state', state: this.currentState });
  }
  private send(message: ServerMessage): void {
    if (this.viewer?.active) this.viewer.send(message);
  }

  private recorded(event: eventWithTime): void {
    if (event.type === EventType.Meta) {
      this.metadata = event;
      return;
    }
    if (!this.viewer?.active) return;
    if (
      event.type === EventType.Custom &&
      event.data.tag === 'floebrowser:focus'
    ) {
      const focus = focusSchema.safeParse(event.data.payload);
      if (focus.success && this.epoch)
        this.send({ type: 'focus', epoch: this.epoch, focus: focus.data });
      return;
    }
    const projected = this.projection.event(event, this.page.url());
    if (!projected) return;
    if (event.type === EventType.FullSnapshot) {
      this.epoch = `${this.recorderKey.slice(-12)}:${++this.generation}`;
      this.sequence = 0;
      const meta = this.metadata ?? {
        type: EventType.Meta,
        timestamp: event.timestamp,
        data: {
          href: this.page.url(),
          width: this.state.width,
          height: this.state.height,
        },
      };
      if (meta.type === EventType.Meta)
        this.state = {
          ...this.state,
          width: meta.data.width,
          height: meta.data.height,
        };
      this.send({
        type: 'snapshot',
        epoch: this.epoch,
        sequence: 0,
        events: [meta, projected],
      });
      this.updateState({ status: 'ready', url: this.page.url() });
      return;
    }
    if (this.epoch)
      this.send({
        type: 'events',
        epoch: this.epoch,
        sequence: ++this.sequence,
        events: [projected],
      });
  }

  async connect(send: (message: ServerMessage) => void): Promise<Controller> {
    if (this.closed || this.controlFault || this.closing)
      throw new Error('The source page is unavailable.');
    if (this.hasController)
      throw new Error('The source page already has a controller.');
    // A previous controller's submitted input and key release must finish first.
    await this.queue;
    if (this.hasController || this.closed || this.controlFault || this.closing)
      throw new Error('The source page is unavailable.');
    const viewer: Viewer = {
      send,
      active: true,
      lastID: 0,
      pending: 0,
      resyncPending: false,
    };
    this.viewer = viewer;
    send({ type: 'hello', version: PROTOCOL_VERSION });
    send({ type: 'state', state: this.currentState });
    await this.snapshot();
    return {
      receive: (message) => this.receive(viewer, message),
      close: async () => {
        if (!viewer.active) return;
        viewer.active = false;
        this.queue = this.queue
          .then(() => this.releaseInput())
          .catch(() => {
            this.controlFault = true;
          });
        await this.queue;
        if (this.viewer === viewer) this.viewer = undefined;
      },
    };
  }

  private async snapshot(): Promise<void> {
    if (this.snapshotPending || this.closed || !this.contextID) return;
    this.snapshotPending = true;
    try {
      await this.evaluate(
        `globalThis[${JSON.stringify(this.recorderKey)}]?.snapshot()`,
      );
    } finally {
      this.snapshotPending = false;
    }
  }

  private receive(viewer: Viewer, input: ClientMessage): Promise<void> {
    if (!viewer.active || this.viewer !== viewer || this.closed)
      return Promise.resolve();
    const parsed = clientMessageSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve();
    const message = parsed.data;
    if (message.type === 'resync') {
      if (viewer.resyncPending) return this.queue;
      viewer.resyncPending = true;
      this.queue = this.queue
        .then(() => (viewer.active ? this.snapshot() : undefined))
        .catch(() => {})
        .finally(() => {
          viewer.resyncPending = false;
        });
      return this.queue;
    }
    if (message.id <= viewer.lastID) {
      viewer.send({
        type: 'ack',
        id: message.id,
        ok: false,
        code: 'stale_view',
      });
      return Promise.resolve();
    }
    viewer.lastID = message.id;
    if (viewer.pending >= MAX_PENDING_COMMANDS) {
      viewer.send({ type: 'ack', id: message.id, ok: false, code: 'busy' });
      return Promise.resolve();
    }
    viewer.pending++;
    this.queue = this.queue.then(async () => {
      try {
        if (!viewer.active || this.viewer !== viewer) return;
        const navigation = ['navigate', 'back', 'forward', 'reload'].includes(
          message.action.kind,
        );
        if (
          (!navigation && (!this.epoch || message.epoch !== this.epoch)) ||
          this.closed
        )
          throw new CommandError('stale_view');
        await this.execute(message, viewer);
        if (viewer.active)
          viewer.send({ type: 'ack', id: message.id, ok: true });
      } catch (error) {
        if (this.heldKeys.size || this.heldButtons.size)
          await this.releaseInput().catch(() => {
            this.controlFault = true;
            viewer.active = false;
          });
        if (viewer.active)
          viewer.send({
            type: 'ack',
            id: message.id,
            ok: false,
            code: error instanceof CommandError ? error.code : 'action_failed',
          });
      } finally {
        viewer.pending--;
      }
    });
    return this.queue;
  }

  private async evaluate(expression: string): Promise<any> {
    if (!this.contextID || this.closed)
      throw new CommandError('target_unavailable');
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      contextId: this.contextID,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new CommandError('target_unavailable');
    return result.result.value;
  }

  private async execute(command: Command, viewer: Viewer): Promise<void> {
    const action = command.action;
    let point: { x: number; y: number } | undefined;
    if (action.kind === 'pointer' || action.kind === 'wheel') {
      point = await this.evaluate(
        `globalThis[${JSON.stringify(this.recorderKey)}]?.point(${action.point.node},${action.point.x},${action.point.y})`,
      );
      if (!point) throw new CommandError('stale_view');
    }
    if (!(await this.options.authorize(action)))
      throw new CommandError('not_allowed');
    const navigation = ['navigate', 'back', 'forward', 'reload'].includes(
      action.kind,
    );
    if (
      !viewer.active ||
      this.viewer !== viewer ||
      this.closed ||
      (!navigation && command.epoch !== this.epoch)
    )
      throw new CommandError('stale_view');
    if (action.kind === 'navigate') {
      await this.page.goto(action.url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      return;
    }
    if (action.kind === 'back') {
      await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
      return;
    }
    if (action.kind === 'forward') {
      await this.page.goForward({
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      return;
    }
    if (action.kind === 'reload') {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      return;
    }
    if (action.kind === 'pointer' || action.kind === 'wheel') {
      if (!point) throw new CommandError('stale_view');
      if (action.kind === 'wheel') {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...point,
          deltaX: action.dx,
          deltaY: action.dy,
          modifiers: action.modifiers,
        });
        return;
      }
      if (action.phase === 'down') this.heldButtons.add(action.button);
      await this.cdp.send('Input.dispatchMouseEvent', {
        type:
          action.phase === 'down'
            ? 'mousePressed'
            : action.phase === 'up'
              ? 'mouseReleased'
              : 'mouseMoved',
        ...point,
        button:
          action.phase === 'move' && !action.buttons ? 'none' : action.button,
        buttons: action.buttons,
        clickCount: action.clicks,
        modifiers: action.modifiers,
      });
      if (action.phase === 'up') this.heldButtons.delete(action.button);
      return;
    }
    if (action.kind === 'text') {
      await this.cdp.send('Input.insertText', { text: action.text });
      return;
    }
    if (action.kind === 'key') {
      const parameters = {
        key: action.key,
        code: action.code,
        modifiers: action.modifiers,
        windowsVirtualKeyCode: keyCode(action.key),
      };
      if (action.phase === 'down') this.heldKeys.set(action.code, parameters);
      await this.cdp.send('Input.dispatchKeyEvent', {
        type:
          action.phase === 'down'
            ? action.key === 'Enter'
              ? 'keyDown'
              : 'rawKeyDown'
            : 'keyUp',
        ...parameters,
        ...(action.phase === 'down' && action.key === 'Enter'
          ? { text: '\r', unmodifiedText: '\r' }
          : {}),
      });
      if (action.phase === 'up') this.heldKeys.delete(action.code);
      return;
    }
    if (action.kind === 'select') {
      if (
        !(await this.evaluate(
          `globalThis[${JSON.stringify(this.recorderKey)}]?.select(${action.node},${JSON.stringify(action.values)})`,
        ))
      )
        throw new CommandError('unsupported');
    }
  }

  private async releaseInput(): Promise<void> {
    if (this.closed) return;
    for (const parameters of this.heldKeys.values())
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        ...parameters,
      });
    if (this.heldButtons.size)
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: -1,
        y: -1,
        button: 'none',
      });
    for (const button of this.heldButtons)
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: button as 'left',
        x: -1,
        y: -1,
      });
    this.heldKeys.clear();
    this.heldButtons.clear();
  }

  close(): Promise<void> {
    return (this.closing ??= this.dispose());
  }

  private async dispose(): Promise<void> {
    if (this.closed) return;
    if (this.viewer) this.viewer.active = false;
    await this.queue;
    await this.releaseInput().catch(() => {
      this.controlFault = true;
    });
    await this.evaluate(
      `globalThis[${JSON.stringify(this.recorderKey)}]?.stop()`,
    ).catch(() => {});
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.scriptID)
      await this.cdp
        .send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: this.scriptID,
        })
        .catch(() => {});
    await this.cdp
      .send('Runtime.removeBinding', { name: this.binding })
      .catch(() => {});
    await this.cdp.detach().catch(() => {});
    this.resources.close();
    attachedPages.delete(this.page);
  }
}

class CommandError extends Error {
  constructor(
    readonly code:
      'stale_view' | 'target_unavailable' | 'unsupported' | 'not_allowed',
  ) {
    super(code);
  }
}
function keyCode(key: string): number {
  const codes: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Escape: 27,
    ' ': 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    Meta: 91,
  };
  return (
    codes[key] ??
    (key.length === 1
      ? key.toUpperCase().charCodeAt(0)
      : /^F\d{1,2}$/.test(key)
        ? 111 + Number(key.slice(1))
        : 0)
  );
}
