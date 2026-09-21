import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import type { Page, CDPSession } from 'playwright';
import {
  clientMessageSchema,
  sourceMediaPacketSchema,
  type SourceMediaPacket,
  focusSchema,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_COMMANDS,
  UNSUPPORTED_SELECTOR,
  PROTOCOL_VERSION,
  type Action,
  type BrowserState,
  type ClientMessage,
  type Command,
  type ServerMessage,
} from '../shared/protocol.js';
import { DOMProjection } from './projection.js';
import { ResourceStore } from './resources.js';
import { FrameBridge } from './frames.js';
import { mapWheelPoint } from '../shared/wheel.js';
import type { SourceMediaBridge, MediaSubscription } from './media-bridge.js';
import type { MediaFrame, MediaFrameHeader } from '../shared/media-wire.js';

const attachedPages = new WeakSet<Page>();

export interface AttachOptions {
  /** Source-host-only element collector; the host owns this shared bridge. */
  mediaBridge?: SourceMediaBridge;
  /** Independent, authorized binary carrier. It must not share the input queue. */
  onMediaFrame?: (frame: MediaFrame) => void;
  onMediaRetired?: (scope: {
    target: string;
    view: string;
    stream: string;
  }) => void;
  /** Called immediately before dispatch. The embedding host remains the authority. */
  authorize: (action: Action) => boolean | Promise<boolean>;
  /** Resolves an opaque resource ID through the host's authorized carrier. */
  resourceURL?: (id: string, tab: string) => string;
  onState?: (state: BrowserState) => void;
  onPopup?: (page: Page) => void;
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
  observing: boolean;
};

/** One page, one projection, one controller. Does not own the browser or profile. */
export class BrowserProjection {
  readonly id = randomBytes(18).toString('base64url');
  readonly resources: ResourceStore;
  private projection: DOMProjection;
  private frames!: FrameBridge;
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
  private stateRead = 0;
  private heldKeys = new Map<string, Record<string, unknown>>();
  private heldButtons = new Set<string>();
  private state: BrowserState;
  private mediaNodes = new Map<number, string>();
  private mediaView = randomBytes(18).toString('base64url');
  private captures = new Map<
    string,
    {
      offer: string;
      node: number;
      view: string;
      subscription?: MediaSubscription;
    }
  >();
  private disposers: Array<() => void> = [];

  private constructor(
    private page: Page,
    private cdp: CDPSession,
    private options: AttachOptions,
  ) {
    this.resources = new ResourceStore(
      cdp,
      (message) => this.send({ type: 'notice', message }),
      options.resourceURL
        ? (id) => options.resourceURL!(id, this.id)
        : undefined,
    );
    this.projection = new DOMProjection(this.resources);
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    this.state = {
      id: this.id,
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
        this.stateRead++;
        this.contextID = context.id;
        this.epoch = '';
        this.clearMedia();
        this.metadata = undefined;
        this.updateState({ status: 'loading' });
      }
    });
    this.listen(this.cdp, 'Runtime.executionContextsCleared', () => {
      this.stateRead++;
      this.contextID = 0;
      this.epoch = '';
      this.clearMedia();
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
        if (!frame.url().startsWith('chrome-error:'))
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
    this.listen(this.page, 'crash', () => {
      this.stateRead++;
      this.epoch = '';
      this.clearMedia();
      this.updateState({ status: 'error' });
    });
    this.listen(this.page, 'popup', (page: Page) =>
      this.options.onPopup
        ? this.options.onPopup(page)
        : this.send({
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
    await this.resources.start();
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
    this.frames = new FrameBridge(
      this.page,
      script,
      this.recorderKey,
      this.resources,
    );
    await this.frames.start();
    await this.refreshState();
  }

  private async refreshState(): Promise<void> {
    if (this.closed) return;
    const read = ++this.stateRead;
    const title = await this.page.title().catch(() => '');
    const history = await this.cdp
      .send('Page.getNavigationHistory')
      .catch(() => undefined);
    const tree = await this.cdp
      .send('Page.getFrameTree')
      .catch(() => undefined);
    const failedURL = tree?.frameTree.frame.unreachableUrl;
    // These asynchronous reads belong to one document. A newer refresh,
    // navigation or crash supersedes them, including old unreachable URLs.
    if (!this.closed && read === this.stateRead)
      this.updateState({
        url: failedURL || this.page.url(),
        title,
        canGoBack: !!history && history.currentIndex > 0,
        canGoForward:
          !!history && history.currentIndex < history.entries.length - 1,
        status: failedURL ? 'error' : this.epoch ? 'ready' : 'loading',
      });
  }
  private updateState(state: Partial<BrowserState>): void {
    this.state = { ...this.state, ...state };
    this.send({ type: 'state', state: this.currentState });
    this.options.onState?.(this.currentState);
  }
  private send(message: ServerMessage): void {
    if (this.viewer?.active) this.viewer.send(message);
  }

  private recorded(event: eventWithTime): void {
    if (event.type === EventType.Meta) {
      this.metadata = event;
      return;
    }
    if (
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.ViewportResize
    ) {
      const { width, height } = event.data;
      if (this.metadata?.type === EventType.Meta)
        this.metadata = {
          ...this.metadata,
          data: { ...this.metadata.data, width, height },
        };
      if (width !== this.state.width || height !== this.state.height)
        this.updateState({ width, height });
    }
    if (
      event.type === EventType.Custom &&
      event.data.tag === 'floebrowser:title'
    ) {
      const title = (event.data.payload as { title?: unknown }).title;
      if (typeof title === 'string') this.updateState({ title });
      return;
    }
    if (!this.viewer?.active || !this.viewer.observing) {
      if (event.type === EventType.FullSnapshot) void this.setMedia(false);
      return;
    }
    if (
      event.type === EventType.Custom &&
      event.data.tag === 'floebrowser:media'
    ) {
      const packet = sourceMediaPacketSchema.safeParse(event.data.payload);
      if (packet.success && this.epoch) {
        const media = packet.data;
        if (media.kind === 'removed') {
          // Removal can follow DOM teardown or a checkpoint that temporarily
          // omits a child document. Always let the receiver retire that node.
          const stream = this.mediaNodes.get(media.id);
          if (stream) this.retireMedia(stream);
          this.mediaNodes.delete(media.id);
        } else {
          if (!this.projection.isMedia(media.id)) return;
          for (const [id, stream] of this.mediaNodes)
            if (stream === media.stream && id !== media.id)
              this.mediaNodes.delete(id);
          if (!this.mediaNodes.has(media.id) && this.mediaNodes.size >= 8)
            return;
          this.mediaNodes.set(media.id, media.stream);
          const capture = this.captures.get(media.stream);
          if (capture) capture.node = media.id;
        }
        if (media.kind === 'offer') void this.collectMedia(media);
        else
          this.send({
            type: 'media',
            epoch: this.epoch,
            view: this.mediaView,
            packet: media,
          });
      }
      return;
    }
    if (
      event.type === EventType.Custom &&
      event.data.tag === 'floebrowser:image'
    ) {
      const { id, src, rawSrc } = event.data.payload as {
        id: number;
        src: string;
        rawSrc?: string | null;
      };
      if (Number.isInteger(id) && typeof src === 'string')
        this.recorded({
          type: 3,
          timestamp: event.timestamp,
          data: {
            source: 0,
            adds: [],
            removes: [],
            texts: [],
            attributes: [
              {
                id,
                attributes: { src },
                ...(rawSrc === null || typeof rawSrc === 'string'
                  ? { floeAttributes: { src: rawSrc } }
                  : {}),
              },
            ],
          },
        });
      return;
    }
    if (
      event.type === EventType.Custom &&
      event.data.tag === 'floebrowser:stylesheet'
    ) {
      const { id, stylesheet } = event.data.payload as any;
      if (
        Number.isInteger(id) &&
        stylesheet &&
        typeof stylesheet.href === 'string' &&
        typeof stylesheet.enabled === 'boolean' &&
        typeof stylesheet.media === 'string' &&
        (stylesheet.text === null || typeof stylesheet.text === 'string')
      )
        this.recorded({
          type: 3,
          timestamp: event.timestamp,
          data: {
            source: 0,
            adds: [],
            removes: [],
            texts: [],
            attributes: [{ id, attributes: {}, floeStylesheet: stylesheet }],
          },
        } as unknown as eventWithTime);
      return;
    }
    if (
      event.type === EventType.Custom &&
      event.data.tag === 'floebrowser:focus'
    ) {
      const { id, ...selection } = event.data.payload as Record<
        string,
        unknown
      >;
      const focus = focusSchema.safeParse({ node: id, ...selection });
      if (focus.success && this.epoch)
        this.send({ type: 'focus', epoch: this.epoch, focus: focus.data });
      return;
    }
    const projected = this.projection.event(event, this.page.url());
    if (!projected) return;
    if (event.type !== EventType.FullSnapshot) {
      const retired: string[] = [];
      for (const [id, stream] of this.mediaNodes) {
        if (this.projection.isMedia(id)) continue;
        this.mediaNodes.delete(id);
        retired.push(stream);
        this.retireMedia(stream);
        this.send({
          type: 'media',
          epoch: this.epoch,
          view: this.mediaView,
          packet: { kind: 'removed', id },
        });
      }
      // DOM teardown retires both endpoints by stream identity. If a page
      // reinserts the same element, its source scan creates a fresh offer.
      // This also handles an iframe disappearing before it can emit removal.
      if (retired.length)
        void Promise.all(
          this.page
            .frames()
            .map((frame) =>
              frame
                .evaluate(
                  ({ key, streams }) =>
                    (window as any)[key]?.retireMedia(streams),
                  { key: this.recorderKey, streams: retired },
                )
                .catch(() => {}),
            ),
        );
    }
    if (event.type === EventType.FullSnapshot) {
      this.epoch = `${this.recorderKey.slice(-12)}:${++this.generation}`;
      this.sequence = 0;
      // Child documents are rebuilt separately. Their forced media states
      // re-admit existing streams after the corresponding DOM is present.
      this.mediaNodes.clear();
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
      if (!this.snapshotPending) void this.setMedia(true);
      return;
    }
    if (
      event.type === EventType.IncrementalSnapshot &&
      (event.data as any).isAttachIframe
    )
      void this.setMedia(true);
    if (this.epoch)
      this.send({
        type: 'events',
        epoch: this.epoch,
        sequence: ++this.sequence,
        events: [projected],
      });
  }

  async connect(send: (message: ServerMessage) => void): Promise<Controller> {
    if (this.closed || this.closing)
      throw new Error('The source page is unavailable.');
    if (this.hasController)
      throw new Error('The source page already has a controller.');
    const viewer: Viewer = {
      send,
      active: true,
      lastID: 0,
      pending: 0,
      resyncPending: false,
      observing: false,
    };
    this.viewer = viewer;
    this.epoch = '';
    let retiring: Promise<void> | undefined;
    const controller: Controller = {
      receive: (message) => this.receive(viewer, message),
      close: () => {
        if (retiring) return retiring;
        viewer.active = false;
        viewer.observing = false;
        const suspended = this.setMedia(false);
        retiring = this.queue = this.queue
          .then(async () => {
            await this.releaseInput();
            await suspended;
            if (this.viewer === viewer) this.viewer = undefined;
          })
          .catch(() => {
            this.controlFault = true;
          });
        return retiring;
      },
    };
    try {
      send({
        type: 'hello',
        version: PROTOCOL_VERSION,
        mediaWireVersion: 1,
      });
      send({ type: 'state', state: this.currentState });
      // Begin observation after old input drains. Snapshot completion must not
      // hold navigation; DOM input remains fenced by the fresh snapshot epoch.
      this.queue = this.queue
        .then(() => {
          if (!viewer.active || this.viewer !== viewer) return;
          if (this.controlFault) {
            this.updateState({ status: 'error' });
            return;
          }
          viewer.observing = true;
          void this.snapshot().catch(() => {
            if (viewer.active && this.viewer === viewer)
              this.updateState({ status: 'error' });
          });
        })
        .catch(() => {
          if (viewer.active && this.viewer === viewer)
            this.updateState({ status: 'error' });
        });
      return controller;
    } catch (error) {
      // Admission owns the lease even before the first snapshot completes.
      await controller.close();
      throw error;
    }
  }

  requestMediaKeyframe(scope: Pick<MediaFrameHeader, 'view' | 'stream'>): void {
    const capture = this.captures.get(scope.stream);
    if (capture?.view === scope.view)
      void capture.subscription?.requestKeyframe().catch(() => {});
  }

  private retireMedia(stream: string): void {
    const capture = this.captures.get(stream);
    this.captures.delete(stream);
    if (capture)
      this.options.onMediaRetired?.({
        target: this.id,
        view: capture.view,
        stream,
      });
    void capture?.subscription?.close().catch(() => {});
  }

  private clearMedia(): void {
    for (const stream of this.captures.keys()) this.retireMedia(stream);
    this.mediaNodes.clear();
    this.mediaView = randomBytes(18).toString('base64url');
  }

  private async collectMedia(
    packet: Extract<SourceMediaPacket, { kind: 'offer' }>,
  ): Promise<void> {
    const bridge = this.options.mediaBridge;
    if (!bridge || !this.viewer?.active) return;
    const old = this.captures.get(packet.stream);
    if (old?.offer === packet.sdp) return;
    if (old) this.retireMedia(packet.stream);
    if (this.captures.size >= 8) return;
    const capture: {
      offer: string;
      node: number;
      view: string;
      subscription?: MediaSubscription;
    } = { offer: packet.sdp, node: packet.id, view: this.mediaView };
    this.captures.set(packet.stream, capture);
    const current = () =>
      this.viewer?.active && this.captures.get(packet.stream) === capture;
    try {
      const subscription = await bridge.open(
        {
          target: this.id,
          view: capture.view,
          stream: packet.stream,
          node: packet.id,
          width: 0,
          height: 0,
        },
        packet.sdp,
        (frame) => {
          if (current() && this.mediaNodes.get(capture.node) === packet.stream)
            this.options.onMediaFrame?.({
              header: { ...frame.header, node: capture.node },
              data: frame.data,
            });
        },
        () => {
          if (current()) void this.mediaFailed(packet.stream, capture.node);
        },
      );
      capture.subscription = subscription;
      if (!current()) {
        await subscription.close();
        return;
      }
      const element = await this.frames.resolve(capture.node);
      if (!element) {
        this.retireMedia(packet.stream);
        return;
      }
      try {
        if (!current()) return;
        await element.evaluate(
          (element, { key, stream, sdp }) =>
            (element as any)[key]?.answer(stream, sdp),
          {
            key: this.recorderKey,
            stream: packet.stream,
            sdp: subscription.sdp,
          },
        );
      } finally {
        await element.dispose();
      }
    } catch {
      if (current()) await this.mediaFailed(packet.stream, capture.node);
    }
  }

  private async mediaFailed(stream: string, node: number): Promise<void> {
    this.retireMedia(stream);
    try {
      const element = await this.frames.resolve(node);
      if (!element) return;
      try {
        if (this.mediaNodes.get(node) !== stream) return;
        await element.evaluate(
          (element, { key, stream }) =>
            (element as any)[key]?.captureFailed(stream),
          { key: this.recorderKey, stream },
        );
      } finally {
        await element.dispose();
      }
    } catch {
      /* A retired document cannot receive media failure state. */
    }
  }

  private async setMedia(active: boolean): Promise<void> {
    if (!active) this.clearMedia();
    await Promise.all(
      this.page.frames().map((frame) =>
        frame
          .evaluate(
            ({ key, active }) =>
              active
                ? (window as any)[key]?.media(true)
                : (window as any)[key]?.suspend(),
            {
              key: this.recorderKey,
              active:
                active &&
                !!this.viewer?.active &&
                this.viewer.observing &&
                !!this.options.mediaBridge &&
                !!this.options.onMediaFrame,
            },
          )
          .catch(() => {}),
      ),
    );
  }

  private async snapshot(): Promise<void> {
    if (this.snapshotPending || this.closed || !this.contextID) return;
    const viewer = this.viewer;
    const contextID = this.contextID;
    const current = () =>
      viewer?.active && this.viewer === viewer && this.contextID === contextID;
    this.snapshotPending = true;
    try {
      await this.evaluate(
        `globalThis[${JSON.stringify(this.recorderKey)}]?.snapshot()`,
      );
      if (!current()) return;
      await this.frames.snapshot();
      if (!current()) return;
      await this.setMedia(true);
    } catch (error) {
      // Navigation destroys the old execution context. Its snapshot failure
      // cannot invalidate the replacement document or another controller.
      if (current()) throw error;
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
    if (message.type === 'media_keyframe') {
      if (message.tab === this.id && message.view === this.mediaView)
        this.requestMediaKeyframe(message);
      return Promise.resolve();
    }
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
        const independent = documentIndependent(message.action);
        if (
          (!independent && (!this.epoch || message.epoch !== this.epoch)) ||
          this.closed ||
          message.tab !== this.id
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
            code:
              error instanceof CommandError
                ? error.code
                : ['navigate', 'back', 'forward', 'reload'].includes(
                      message.action.kind,
                    )
                  ? 'navigation_failed'
                  : 'action_failed',
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
    if (!(await this.options.authorize(action)))
      throw new CommandError('not_allowed');
    const independent = documentIndependent(action);
    const assertCurrent = () => {
      if (
        !viewer.active ||
        this.viewer !== viewer ||
        this.closed ||
        command.tab !== this.id ||
        (!independent && command.epoch !== this.epoch)
      )
        throw new CommandError('stale_view');
    };
    assertCurrent();
    if (this.controlFault) throw new CommandError('target_unavailable');
    if (action.kind === 'viewport') {
      const size = { width: action.width, height: action.height };
      const current = this.page.viewportSize();
      if (current?.width !== size.width || current.height !== size.height) {
        await this.page.setViewportSize(size);
        this.updateState(size);
      }
      return;
    }
    if (action.kind === 'media') {
      const element = await this.frames.resolve(action.node);
      if (!element) throw new CommandError('target_unavailable');
      try {
        assertCurrent();
        const result = await element.evaluate(
          (node, { action, key }) => {
            if (!['VIDEO', 'AUDIO'].includes(node.tagName) || !node.isConnected)
              return false;
            const media = node as HTMLMediaElement;
            if (action.operation === 'play') {
              // Acknowledge issuing the request. Waiting for buffering here would
              // hold the serialized input queue, including pause and disconnect.
              if (media.paused) {
                const capture = (media as any)[key];
                void media.play().catch((error) => {
                  if (error.name !== 'AbortError') capture?.playbackFailed();
                });
              }
            } else if (action.operation === 'pause') media.pause();
            else if (action.operation === 'reveal') {
              const rect = media.getBoundingClientRect();
              if (
                !rect.width ||
                !rect.height ||
                !media.checkVisibility({
                  checkOpacity: true,
                  checkVisibilityCSS: true,
                })
              )
                return false;
              // Source scrolling is projected normally; locating never plays,
              // focuses or clicks website content.
              media.scrollIntoView({
                behavior: 'instant',
                block: 'center',
                inline: 'center',
              });
            } else if (
              action.time !== undefined &&
              Number.isFinite(media.duration)
            )
              media.currentTime = Math.min(action.time, media.duration);
            else return false;
            return true;
          },
          { action, key: this.recorderKey },
        );
        if (!result) throw new CommandError('unsupported');
      } finally {
        await element.dispose();
      }
      return;
    }
    if (action.kind.startsWith('tab_')) throw new CommandError('unsupported');
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
      const point = await this.resolvePoint(
        action.point,
        action.kind === 'wheel' ? action : undefined,
      );
      assertCurrent();
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
        windowsVirtualKeyCode: keyCode(action.key, action.code),
      };
      if (action.phase === 'down') this.heldKeys.set(action.code, parameters);
      // Native keyDown preserves shortcuts and the page's preventDefault()
      // decision before text insertion. IME and paste retain insertText.
      const text =
        action.key === 'Enter'
          ? '\r'
          : action.key.length === 1 && !(action.modifiers & 7)
            ? action.key
            : undefined;
      await this.cdp.send('Input.dispatchKeyEvent', {
        type:
          action.phase === 'down'
            ? text !== undefined
              ? 'keyDown'
              : 'rawKeyDown'
            : 'keyUp',
        ...parameters,
        ...(action.phase === 'down' && text !== undefined
          ? { text, unmodifiedText: text }
          : {}),
      });
      if (action.phase === 'up') this.heldKeys.delete(action.code);
      return;
    }
    if (action.kind === 'select') {
      const element = await this.frames.resolve(action.node);
      if (!element) throw new CommandError('stale_view');
      try {
        assertCurrent();
        const selected = await element.evaluate((node, values) => {
          const select = node as HTMLSelectElement;
          if (
            select.tagName !== 'SELECT' ||
            !select.isConnected ||
            select.disabled ||
            (!select.multiple && values.length !== 1)
          )
            return false;
          if (
            values.some(
              (value) =>
                !Array.from(select.options).some(
                  (option) => option.value === value && !option.disabled,
                ),
            )
          )
            return false;
          select.focus();
          for (const option of select.options)
            option.selected = values.includes(option.value);
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, action.values);
        if (!selected) throw new CommandError('unsupported');
      } finally {
        await element.dispose();
      }
    }
  }

  private async resolvePoint(
    point: {
      node: number;
      x: number;
      y: number;
    },
    wheel?: Extract<Action, { kind: 'wheel' }>,
  ): Promise<{ x: number; y: number } | undefined> {
    const element = await this.frames.resolve(point.node);
    if (!element) return;
    try {
      const local = wheel
        ? await element.evaluate(mapWheelPoint, {
            space: 'viewport' as const,
            x: point.x,
            y: point.y,
            dx: wheel.dx,
            dy: wheel.dy,
          })
        : await element.evaluate(
            (node, { point, unsupported }) => {
              if (!node.isConnected || node.closest(unsupported)) return;
              const rect = node.getBoundingClientRect();
              const win = node.ownerDocument.defaultView!;
              if (!rect.width || !rect.height) return;
              const x = Math.max(
                0,
                Math.min(win.innerWidth - 1, rect.x + rect.width * point.x),
              );
              const y = Math.max(
                0,
                Math.min(win.innerHeight - 1, rect.y + rect.height * point.y),
              );
              const hit = (
                node.getRootNode() as Document | ShadowRoot
              ).elementFromPoint(x, y);
              if (!hit || !(hit === node || node.contains(hit))) return;
              return { x, y };
            },
            { point, unsupported: UNSUPPORTED_SELECTOR },
          );
      if (!local) return;
      let position = { x: local.x, y: local.y };
      // Map viewport coordinates through each frame, checking its hit target.
      // Never derive viewport input from the document's moving content box.
      for (
        let frame = await element.ownerFrame();
        frame?.parentFrame();
        frame = frame.parentFrame()
      ) {
        const owner = await frame.frameElement();
        try {
          const mapped = await owner.evaluate((node, point) => {
            const frame = node as HTMLElement;
            const rect = frame.getBoundingClientRect();
            if (
              !frame.isConnected ||
              !rect.width ||
              !rect.height ||
              !frame.offsetWidth ||
              !frame.offsetHeight
            )
              return;
            const x =
              rect.x +
              ((frame.clientLeft + point.x) * rect.width) / frame.offsetWidth;
            const y =
              rect.y +
              ((frame.clientTop + point.y) * rect.height) / frame.offsetHeight;
            const hit = (
              frame.getRootNode() as Document | ShadowRoot
            ).elementFromPoint(x, y);
            if (hit !== frame) return;
            return { x, y };
          }, position);
          if (!mapped) return;
          position = mapped;
        } finally {
          await owner.dispose();
        }
      }
      return position;
    } finally {
      await element.dispose();
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
    this.clearMedia();
    await this.queue;
    await this.releaseInput().catch(() => {
      this.controlFault = true;
    });
    await this.frames?.close();
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
function documentIndependent(action: Action): boolean {
  return ['navigate', 'back', 'forward', 'reload', 'viewport'].includes(
    action.kind,
  );
}
function keyCode(key: string, code: string): number {
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
    Semicolon: 186,
    Equal: 187,
    Comma: 188,
    Minus: 189,
    Period: 190,
    Slash: 191,
    Backquote: 192,
    BracketLeft: 219,
    Backslash: 220,
    BracketRight: 221,
    Quote: 222,
    IntlBackslash: 226,
    NumpadMultiply: 106,
    NumpadAdd: 107,
    NumpadSubtract: 109,
    NumpadDecimal: 110,
    NumpadDivide: 111,
  };
  return (
    codes[code] ??
    codes[key] ??
    (/^Digit[0-9]$/.test(code)
      ? code.charCodeAt(5)
      : /^Numpad[0-9]$/.test(code)
        ? 96 + Number(code.slice(-1))
        : key.length === 1
          ? key.toUpperCase().charCodeAt(0)
          : /^F\d{1,2}$/.test(key)
            ? 111 + Number(key.slice(1))
            : 0)
  );
}
