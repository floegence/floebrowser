import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import type { Page } from 'playwright';
import type {
  SourceDialog,
  SourcePage,
  SourceTransport,
  SourceFileChooser,
} from './source.js';
import {
  sourceUploads,
  type UploadBatch,
  type UploadLimits,
} from './uploads.js';
import { PlaywrightSourceBrowser } from './playwright-source.js';
import {
  clientMessageSchema,
  sourceMediaPacketSchema,
  type SourceMediaPacket,
  focusSchema,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_COMMANDS,
  MAX_VIEWPORT_DIMENSION,
  UNSUPPORTED_SELECTOR,
  PROTOCOL_VERSION,
  type Action,
  type BrowserState,
  type ClientMessage,
  type Command,
  type DialogState,
  type FileChooserState,
  type UploadFile,
  type ServerMessage,
} from '../shared/protocol.js';
import { DOMProjection } from './projection.js';
import { ResourceStore } from './resources.js';
import { FrameBridge } from './frames.js';
import { SourceFind } from './find.js';
import { mapWheelPoint } from '../shared/wheel.js';
import type { SourceMediaBridge, MediaSubscription } from './media-bridge.js';
import type { MediaFrame, MediaFrameHeader } from '../shared/media-wire.js';

const attachedPages = new WeakSet<object>();

export interface AttachOptions {
  uploadLimits?: UploadLimits;
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
  onPopup?: (page: SourcePage) => void;
  /** The host's existing AI/local-browser dialog owner, used only without a
   * projection controller. Omission cancels unattended dialogs. */
  onUncontrolledDialog?: (dialog: SourceDialog, page: SourcePage) => void;
}
export interface Controller {
  receive(message: ClientMessage): Promise<void>;
  /** Stream an explicitly selected client file over an independently authorized
   * host carrier. Returned identities belong only to this pending chooser. */
  upload(
    chooser: string,
    file: UploadFile,
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<string>;
  close(): Promise<void>;
}
export interface ObservationOptions {
  /** Host audio-output grant, independent of visible pictures and source mute. */
  audio?: boolean;
  /** Hidden observations retain authorized audio without DOM or picture traffic. */
  visible?: boolean;
  /** The host may admit DOM before its independently authorized media carrier. */
  media?: boolean;
  onMediaFrame?: (frame: MediaFrame) => void;
  onMediaRetired?: (scope: {
    target: string;
    view: string;
    stream: string;
  }) => void;
}
export interface Observation {
  readonly id: string;
  /** Only resynchronization and media recovery are accepted here, never input. */
  receive(message: ClientMessage): Promise<void>;
  setMedia(enabled: boolean): Promise<void>;
  setAudio(enabled: boolean): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  close(): Promise<void>;
}
type Watcher = ObservationOptions & {
  id: string;
  view: string;
  active: boolean;
  mediaEnabled: boolean;
  audioEnabled: boolean;
  visible: boolean;
  send: (message: ServerMessage) => void;
  resyncPending: boolean;
  control?: Controller;
  closing?: Promise<void>;
};
type Viewer = {
  watcher: Watcher;
  send: (message: ServerMessage) => void;
  authorize: AttachOptions['authorize'];
  isCurrent?: () => boolean;
  active: boolean;
  lastID: number;
  pending: number;
};

/** One source page and input queue, with independently authorized observers. */
export class BrowserProjection {
  readonly id: string;
  private ownedSource?: PlaywrightSourceBrowser;
  readonly resources: ResourceStore;
  private projection: DOMProjection;
  private frames!: FrameBridge;
  private find: SourceFind;
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
  private dialog?: { source: SourceDialog; state: DialogState; viewer: Viewer };
  private chooser?: {
    source: SourceFileChooser;
    state: FileChooserState;
    viewer: Viewer;
    batch: UploadBatch;
  };
  private uploads: ReturnType<typeof sourceUploads>;
  private watchers = new Set<Watcher>();
  private observations = new WeakMap<Observation, Watcher>();
  private snapshotTask?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private controlFault = false;
  private closing?: Promise<void>;
  private snapshotPending = false;
  private stateRead = 0;
  private heldKeys = new Map<string, Record<string, unknown>>();
  private heldButtons = new Set<string>();
  private state: BrowserState;
  private displayViewport: { width: number; height: number };
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
    private page: SourcePage,
    private cdp: SourceTransport,
    private options: AttachOptions,
  ) {
    this.id = page.id;
    this.uploads = sourceUploads(page, options.uploadLimits);
    this.find = new SourceFind(page);
    this.resources = new ResourceStore(
      cdp,
      (code) => this.send({ type: 'notice', code }),
      options.resourceURL
        ? (id) => options.resourceURL!(id, this.id)
        : undefined,
    );
    this.projection = new DOMProjection(this.resources);
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    this.displayViewport = { ...viewport };
    this.state = {
      id: this.id,
      url: page.url(),
      title: '',
      status: 'loading',
      loading: false,
      zoom: 1,
      canGoBack: false,
      canGoForward: false,
      ...viewport,
    };
  }

  static async attach(
    page: Page | SourcePage,
    options: AttachOptions,
  ): Promise<BrowserProjection> {
    if (attachedPages.has(page))
      throw new Error('This page already has a FloeBrowser projection.');
    attachedPages.add(page);
    let engine: BrowserProjection | undefined;
    let owner: PlaywrightSourceBrowser | undefined;
    try {
      owner = 'transport' in page ? undefined : new PlaywrightSourceBrowser();
      const source = 'transport' in page ? page : await owner!.adopt(page);
      if (source !== page && attachedPages.has(source))
        throw new Error('This page already has a FloeBrowser projection.');
      attachedPages.add(source);
      engine = new BrowserProjection(source, source.transport, options);
      engine.ownedSource = owner;
      engine.disposers.push(() => attachedPages.delete(page));
      await engine.initialize();
      return engine;
    } catch (error) {
      await engine?.close();
      await owner?.dispose();
      attachedPages.delete(page);
      throw error;
    }
  }

  get source(): SourcePage {
    return this.page;
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
    this.contextID = this.page.mainFrame().contextID;
    this.listen(this.cdp, 'Page.frameStartedLoading', ({ frameId }) => {
      if (frameId === this.mainFrameID) this.updateState({ loading: true });
    });
    this.listen(this.cdp, 'Page.frameStoppedLoading', ({ frameId }) => {
      if (frameId === this.mainFrameID) this.updateState({ loading: false });
    });
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
          code: 'dom_limit',
        });
        return;
      }
      try {
        this.recorded(JSON.parse(event.payload));
      } catch {
        this.send({
          type: 'notice',
          code: 'dom_update_failed',
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
    this.listen(this.page, 'popup', (page: SourcePage) =>
      this.options.onPopup
        ? this.options.onPopup(page)
        : this.send({
            type: 'notice',
            code: 'popup_unavailable',
          }),
    );
    this.listen(this.page, 'dialog', (source: SourceDialog) => {
      const viewer = this.viewer;
      if (!viewer?.active || (viewer.isCurrent && !viewer.isCurrent())) {
        if (this.options.onUncontrolledDialog) {
          this.options.onUncontrolledDialog(source, this.page);
          return;
        }
        // Unattended dialogs cannot stall the source or silently accept effects.
        void source.respond(false).catch(() => {});
        return;
      }
      const state: DialogState = {
        id: randomBytes(18).toString('base64url'),
        type: source.type,
        url: source.url.slice(0, 8192),
        message: source.message.slice(0, 16000),
        defaultPrompt: (source.defaultPrompt ?? '').slice(0, 16000),
        truncated:
          source.message.length > 16000 ||
          (source.defaultPrompt?.length ?? 0) > 16000,
      };
      this.dialog = { source, state, viewer };
      viewer.send({ type: 'dialog', target: this.id, dialog: state });
    });
    this.listen(this.page, 'dialogclosed', () => this.clearDialog());
    this.listen(this.page, 'filechooser', (source: SourceFileChooser) => {
      void this.dismissFiles();
      const viewer = this.viewer;
      if (!viewer?.active || (viewer.isCurrent && !viewer.isCurrent())) {
        void source.respond(null).catch(() => {});
        return;
      }
      const state: FileChooserState = {
        id: randomBytes(18).toString('base64url'),
        target: this.id,
        url: source.url.slice(0, 8192),
        multiple: source.multiple,
        directory: source.directory,
        accept: source.accept,
        ...this.uploads.budget.remaining,
      };
      this.chooser = {
        source,
        state,
        viewer,
        batch: this.uploads.budget.create(source.directory),
      };
      viewer.send({ type: 'file_chooser', target: this.id, chooser: state });
    });
    this.listen(this.page, 'filechooserfailed', () => {
      if (this.viewer?.active)
        this.viewer.send({ type: 'notice', code: 'file_unavailable' });
    });
    const retireFiles = () => {
      if (this.chooser && !this.chooser.source.current())
        void this.dismissFiles();
    };
    this.listen(this.page, 'documentchanged', retireFiles);
    this.listen(this.page, 'framedetached', retireFiles);
    this.listen(this.page, 'download', () =>
      this.send({
        type: 'notice',
        code: 'download_source_only',
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
    if (this.controlFault && this.hasController && state.status === 'ready')
      state = { ...state, status: 'error' };
    this.state = { ...this.state, ...state };
    this.send({ type: 'state', state: this.currentState });
    this.options.onState?.(this.currentState);
  }
  private send(message: ServerMessage): void {
    for (const watcher of this.watchers) {
      if (!watcher.active) continue;
      if (message.type === 'media' && !watcher.mediaEnabled) continue;
      if (
        !watcher.visible &&
        ['snapshot', 'events', 'focus'].includes(message.type)
      )
        continue;
      try {
        watcher.send(
          message.type === 'media'
            ? { ...message, view: watcher.view }
            : message,
        );
      } catch {
        void this.unobserve(watcher);
      }
    }
  }
  private get domWatched(): boolean {
    return [...this.watchers].some(
      (watcher) => watcher.active && watcher.visible,
    );
  }
  private get picturesWatched(): boolean {
    return [...this.watchers].some(
      (watcher) => watcher.active && watcher.visible && watcher.mediaEnabled,
    );
  }
  private get mediaWatched(): boolean {
    return [...this.watchers].some(
      (watcher) =>
        watcher.active && watcher.mediaEnabled && !!watcher.onMediaFrame,
    );
  }

  private recorded(event: eventWithTime): void {
    // A Chromium network-error document is browser UI, not website content.
    // Its recorder checkpoint must never turn a failed navigation into a ready
    // projection or replace the failed address with chrome-error://chromewebdata.
    if (this.page.url().startsWith('chrome-error:')) return;
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
    if (!this.watchers.size) {
      if (event.type === EventType.FullSnapshot) void this.setMedia(false);
      return;
    }
    if (
      event.type === EventType.Custom &&
      event.data.tag === 'floebrowser:media'
    ) {
      const packet = sourceMediaPacketSchema.safeParse(event.data.payload);
      if (packet.success && this.mediaWatched) {
        const media = packet.data;
        if (media.kind === 'removed') {
          // Removal can follow DOM teardown or a checkpoint that temporarily
          // omits a child document. Always let the receiver retire that node.
          const stream = this.mediaNodes.get(media.id);
          if (stream) this.retireMedia(stream);
          this.mediaNodes.delete(media.id);
        } else {
          if (this.domWatched && !this.projection.isMedia(media.id)) return;
          for (const [id, stream] of this.mediaNodes)
            if (stream === media.stream && id !== media.id)
              this.mediaNodes.delete(id);
          if (!this.mediaNodes.has(media.id) && this.mediaNodes.size >= 8)
            return;
          const previous = this.mediaNodes.get(media.id);
          if (previous && previous !== media.stream) this.retireMedia(previous);
          this.mediaNodes.set(media.id, media.stream);
          const capture = this.captures.get(media.stream);
          if (capture) capture.node = media.id;
        }
        if (media.kind === 'offer') void this.collectMedia(media);
        else
          this.send({
            type: 'media',
            target: this.id,
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
    if (!this.domWatched) {
      if (event.type === EventType.FullSnapshot)
        void this.setMedia(this.mediaWatched);
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
          target: this.id,
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

  async observe(
    send: (message: ServerMessage) => void,
    options: ObservationOptions = {},
  ): Promise<Observation> {
    if (this.closed || this.closing || this.watchers.size >= 16)
      throw new Error('Source observation unavailable');
    const watcher: Watcher = {
      ...options,
      id: randomBytes(18).toString('base64url'),
      view: randomBytes(18).toString('base64url'),
      active: true,
      mediaEnabled: !!options.onMediaFrame && options.media !== false,
      audioEnabled: options.audio !== false,
      visible: options.visible !== false,
      send,
      resyncPending: false,
    };
    this.watchers.add(watcher);
    const observation: Observation = {
      id: watcher.id,
      receive: (message) => this.receiveObservation(watcher, message),
      setVisible: async (visible) => {
        if (!watcher.active || watcher.visible === visible) return;
        watcher.visible = visible;
        if (!this.domWatched) this.epoch = '';
        if (!visible) await watcher.control?.close();
        if (visible) {
          watcher.send({ type: 'state', state: this.currentState });
          await this.snapshot();
        }
        await this.setMedia(this.mediaWatched);
        if (visible)
          for (const capture of this.captures.values())
            void capture.subscription?.requestKeyframe().catch(() => {});
      },
      setAudio: async (enabled) => {
        if (!watcher.active || watcher.audioEnabled === enabled) return;
        watcher.audioEnabled = enabled;
        // A permission generation change retires queued audio before enabling
        // its new owner. The source collector and website playback stay alive.
        this.resetMediaSubscription(watcher);
        await this.setMedia(this.mediaWatched);
      },
      setMedia: async (enabled) => {
        if (
          !watcher.active ||
          watcher.mediaEnabled === enabled ||
          (enabled && !watcher.onMediaFrame)
        )
          return;
        watcher.mediaEnabled = enabled;
        this.resetMediaSubscription(watcher);
        await this.setMedia(this.mediaWatched);
      },
      close: () => this.unobserve(watcher),
    };
    this.observations.set(observation, watcher);
    try {
      send({ type: 'hello', version: PROTOCOL_VERSION, mediaWireVersion: 1 });
      send({ type: 'state', state: this.currentState });
      send({ type: 'control', target: this.id, active: false });
      void (
        watcher.visible ? this.snapshot() : this.setMedia(this.mediaWatched)
      ).catch(() => {
        if (watcher.active && !this.closed)
          this.updateState({ status: 'error' });
      });
      return observation;
    } catch (error) {
      await this.unobserve(watcher);
      throw error;
    }
  }

  private resetMediaSubscription(watcher: Watcher): void {
    watcher.send({ type: 'media_end', target: this.id, view: watcher.view });
    for (const stream of this.captures.keys())
      watcher.onMediaRetired?.({ target: this.id, view: watcher.view, stream });
    watcher.view = randomBytes(18).toString('base64url');
  }

  private unobserve(watcher: Watcher): Promise<void> {
    if (watcher.closing) return watcher.closing;
    watcher.active = false;
    this.watchers.delete(watcher);
    if (!this.watchers.size) this.epoch = '';
    try {
      watcher.send({ type: 'media_end', target: this.id, view: watcher.view });
    } catch {
      /* The viewer carrier may already be closed. */
    }
    for (const stream of this.captures.keys())
      watcher.onMediaRetired?.({ target: this.id, view: watcher.view, stream });
    const drain = watcher.control?.close();
    return (watcher.closing = Promise.all([
      drain,
      this.setMedia(this.mediaWatched),
    ]).then(() => {}));
  }

  /** The embedding host must authorize this grant before calling. It never
   * implicitly takes a lease from an existing user or AI controller. */
  async acquireControl(
    observation: Observation,
    authorize: AttachOptions['authorize'],
    isCurrent?: () => boolean,
  ): Promise<Controller> {
    const watcher = this.observations.get(observation);
    if (
      !watcher?.active ||
      !watcher.visible ||
      this.closed ||
      this.closing ||
      this.hasController
    )
      throw new Error('Source control unavailable');
    const viewer: Viewer = {
      watcher,
      send: watcher.send,
      authorize,
      isCurrent,
      active: true,
      lastID: 0,
      pending: 0,
    };
    this.viewer = viewer;
    let retiring: Promise<void> | undefined;
    const controller: Controller = {
      receive: (message) => this.receive(viewer, message),
      upload: async (id, file, body, signal) => {
        const chooser = this.chooser;
        const current = () =>
          viewer.active &&
          this.viewer === viewer &&
          (!viewer.isCurrent || viewer.isCurrent()) &&
          chooser?.viewer === viewer &&
          chooser.state.id === id &&
          chooser.source.current() &&
          this.chooser === chooser;
        if (!current() || !chooser) throw new Error('File chooser unavailable');
        const result = await chooser.batch.write(file, body, signal);
        if (!current()) throw new Error('File chooser expired');
        return result;
      },
      close: () => {
        if (retiring) return retiring;
        viewer.active = false;
        const dialogDrain = this.dismissDialog(viewer);
        const fileDrain = this.dismissFiles(viewer);
        const interception = this.page.setFileChooserIntercepted(false);
        this.find = new SourceFind(this.page);
        try {
          watcher.send({ type: 'control', target: this.id, active: false });
        } catch {
          /* Disconnected carrier. */
        }
        if (watcher.control === controller) watcher.control = undefined;
        retiring = this.queue = Promise.all([
          this.queue,
          dialogDrain,
          fileDrain,
          interception,
        ])
          .then(async () => {
            await this.releaseInput();
            if (this.viewer === viewer) this.viewer = undefined;
          })
          .catch(() => {
            this.controlFault = true;
          });
        return retiring;
      },
    };
    watcher.control = controller;
    watcher.send({ type: 'control', target: this.id, active: true });
    this.queue = this.queue.then(async () => {
      if (
        !viewer.active ||
        this.viewer !== viewer ||
        (viewer.isCurrent && !viewer.isCurrent())
      )
        return;
      // Renderer configuration precedes this page's input, never session/tab
      // admission. A hung renderer must not prevent creating a healthy tab.
      await this.page.setFileChooserIntercepted(true).catch(() => {
        this.controlFault = true;
      });
      if (viewer.active && this.viewer === viewer && this.controlFault)
        this.updateState({ status: 'error' });
    });
    return controller;
  }

  /** Convenience for private standalone hosts that grant both viewing and input. */
  async connect(send: (message: ServerMessage) => void): Promise<Controller> {
    if (this.hasController)
      throw new Error('The source page already has a controller.');
    const observation = await this.observe(send, this.options);
    try {
      const controller = await this.acquireControl(
        observation,
        this.options.authorize,
      );
      return {
        receive: controller.receive,
        upload: controller.upload,
        close: () => observation.close(),
      };
    } catch (error) {
      await observation.close();
      throw error;
    }
  }

  private receiveObservation(
    watcher: Watcher,
    input: ClientMessage,
  ): Promise<void> {
    if (!watcher.active || this.closed) return Promise.resolve();
    const parsed = clientMessageSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve();
    const message = parsed.data;
    if (message.type === 'command') {
      watcher.send({
        type: 'ack',
        id: message.id,
        ok: false,
        code: 'not_allowed',
      });
      return Promise.resolve();
    }
    if (message.type === 'media_keyframe') {
      if (
        watcher.mediaEnabled &&
        message.tab === this.id &&
        message.view === watcher.view
      )
        this.requestMediaKeyframe(message);
      return Promise.resolve();
    }
    if (!watcher.visible || watcher.resyncPending) return Promise.resolve();
    watcher.resyncPending = true;
    return this.snapshot()
      .catch(() => {})
      .finally(() => {
        watcher.resyncPending = false;
      });
  }

  requestMediaKeyframe(scope: Pick<MediaFrameHeader, 'view' | 'stream'>): void {
    const capture = this.captures.get(scope.stream);
    if (
      capture &&
      [...this.watchers].some(
        (watcher) =>
          watcher.active && watcher.mediaEnabled && watcher.view === scope.view,
      )
    )
      void capture.subscription?.requestKeyframe().catch(() => {});
  }

  private retireMedia(stream: string): void {
    const capture = this.captures.get(stream);
    this.captures.delete(stream);
    if (capture)
      for (const watcher of this.watchers)
        watcher.onMediaRetired?.({
          target: this.id,
          view: watcher.view,
          stream,
        });
    void capture?.subscription?.close().catch(() => {});
  }

  private clearMedia(): void {
    for (const stream of this.captures.keys()) this.retireMedia(stream);
    this.mediaNodes.clear();
    this.mediaView = randomBytes(18).toString('base64url');
    for (const watcher of this.watchers) {
      try {
        watcher.send({
          type: 'media_end',
          target: this.id,
          view: watcher.view,
        });
      } catch {
        /* Carrier already closed. */
      }
      watcher.view = randomBytes(18).toString('base64url');
    }
  }

  private async collectMedia(
    packet: Extract<SourceMediaPacket, { kind: 'offer' }>,
  ): Promise<void> {
    const bridge = this.options.mediaBridge;
    if (!bridge || !this.mediaWatched) return;
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
      this.mediaWatched && this.captures.get(packet.stream) === capture;
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
          if (!current() || this.mediaNodes.get(capture.node) !== packet.stream)
            return;
          for (const watcher of this.watchers) {
            if (
              !watcher.active ||
              !watcher.mediaEnabled ||
              (!watcher.audioEnabled && frame.header.track === 'audio') ||
              (!watcher.visible && frame.header.track !== 'audio')
            )
              continue;
            try {
              watcher.onMediaFrame?.({
                header: {
                  ...frame.header,
                  node: capture.node,
                  view: watcher.view,
                },
                data: frame.data,
              });
            } catch {
              void this.unobserve(watcher);
            }
          }
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
    const enabled = active && this.mediaWatched && !!this.options.mediaBridge;
    if (!enabled) this.clearMedia();
    const observing = this.domWatched;
    const pictures = this.picturesWatched;
    await Promise.all(
      this.page.frames().map((frame) =>
        frame
          .evaluate(
            ({ key, enabled, observing, pictures }) => {
              (window as any)[key]?.display(observing);
              (window as any)[key]?.media(enabled, pictures);
            },
            { key: this.recorderKey, enabled, observing, pictures },
          )
          .catch(() => {}),
      ),
    );
  }

  private snapshot(): Promise<void> {
    if (this.closed || !this.contextID || !this.domWatched)
      return Promise.resolve();
    if (this.snapshotTask) return this.snapshotTask.then(() => this.snapshot());
    const contextID = this.contextID;
    const current = () => this.domWatched && this.contextID === contextID;
    this.snapshotPending = true;
    const task = (async () => {
      try {
        await this.evaluate(
          `globalThis[${JSON.stringify(this.recorderKey)}]?.snapshot()`,
        );
        if (!current()) return;
        await this.frames.snapshot();
        if (current()) await this.setMedia(this.mediaWatched);
      } catch (error) {
        if (current()) throw error;
      } finally {
        this.snapshotPending = false;
        this.snapshotTask = undefined;
      }
    })();
    this.snapshotTask = task;
    return task;
  }

  private receive(viewer: Viewer, input: ClientMessage): Promise<void> {
    if (!viewer.active || this.viewer !== viewer || this.closed)
      return Promise.resolve();
    const parsed = clientMessageSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve();
    const message = parsed.data;
    if (message.type !== 'command')
      return this.receiveObservation(viewer.watcher, message);
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
    const work = async () => {
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
        if (
          viewer.active &&
          error instanceof CommandError &&
          error.code === 'not_allowed' &&
          message.action.kind === 'dialog_reply' &&
          this.dialog?.viewer === viewer &&
          this.dialog.state.id === message.action.dialog
        )
          viewer.send({
            type: 'dialog',
            target: this.id,
            dialog: this.dialog.state,
          });
      } finally {
        viewer.pending--;
      }
    };
    if (['stop', 'dialog_reply'].includes(message.action.kind)) {
      // Cancellation and dialog replies can release the operation being awaited.
      // Later effects still wait for both the old work and this cancellation.
      const cancellation = work();
      this.queue = Promise.all([this.queue, cancellation]).then(() => {});
      return cancellation;
    }
    this.queue = this.queue.then(work);
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
    if (!(await viewer.authorize(action)))
      throw new CommandError('not_allowed');
    const independent = documentIndependent(action);
    const assertCurrent = () => {
      if (viewer.isCurrent && !viewer.isCurrent())
        throw new CommandError('not_allowed');
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
    if (action.kind === 'file_reply') {
      const chooser = this.chooser;
      if (
        !chooser ||
        chooser.viewer !== viewer ||
        chooser.state.id !== action.chooser ||
        !chooser.source.current()
      )
        throw new CommandError('stale_view');
      if (action.files === null) {
        await this.dismissFiles(viewer);
        return;
      }
      if (
        !chooser.source.multiple &&
        !chooser.source.directory &&
        action.files.length !== 1
      )
        throw new CommandError('unsupported');
      const paths = await chooser.batch.readyPaths(action.files);
      assertCurrent();
      if (this.chooser !== chooser || !chooser.source.current())
        throw new CommandError('stale_view');
      // Chromium may read selected files lazily. Retain them for the source
      // document even when its controller disconnects or selection changes.
      chooser.batch.commit();
      this.uploads.retain(chooser.batch, chooser.source.frame);
      this.clearFiles();
      await chooser.source.respond(paths);
      return;
    }
    if (action.kind === 'find') {
      const found = await this.find.next(
        action.query,
        action.backwards,
        action.restart,
        assertCurrent,
      );
      assertCurrent();
      viewer.send({
        type: 'find',
        target: this.id,
        epoch: this.epoch,
        query: action.query,
        found,
      });
      return;
    }
    if (action.kind === 'dialog_reply') {
      const dialog = this.dialog;
      if (
        !dialog ||
        dialog.viewer !== viewer ||
        dialog.state.id !== action.dialog
      )
        throw new CommandError('stale_view');
      this.clearDialog();
      await dialog.source.respond(action.accept, action.text);
      return;
    }
    if (action.kind === 'viewport' || action.kind === 'zoom') {
      const display =
        action.kind === 'viewport'
          ? { width: action.width, height: action.height }
          : this.displayViewport;
      const zoom = action.kind === 'zoom' ? action.factor : this.state.zoom;
      const size = {
        width: Math.max(1, Math.round(display.width / zoom)),
        height: Math.max(1, Math.round(display.height / zoom)),
      };
      if (
        size.width > MAX_VIEWPORT_DIMENSION ||
        size.height > MAX_VIEWPORT_DIMENSION
      )
        throw new CommandError('unsupported');
      const current = this.page.viewportSize();
      if (
        current?.width !== size.width ||
        current.height !== size.height ||
        this.state.zoom !== zoom
      ) {
        await this.page.setViewportSize(size, zoom);
        this.updateState({ ...size, zoom });
      }
      this.displayViewport = display;
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
          { userGesture: true },
        );
        if (!result) throw new CommandError('unsupported');
      } finally {
        await element.dispose();
      }
      return;
    }
    if (action.kind.startsWith('tab_')) throw new CommandError('unsupported');
    if (action.kind === 'stop') {
      await this.page.stop();
      this.updateState({ loading: false });
      void this.refreshState();
      return;
    }
    if (action.kind === 'navigate') {
      await this.page.navigate(action.url);
      return;
    }
    if (action.kind === 'back') {
      await this.page.traverse(-1);
      return;
    }
    if (action.kind === 'forward') {
      await this.page.traverse(1);
      return;
    }
    if (action.kind === 'reload') {
      await this.page.reload();
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
        const selected = await element.evaluate(
          (node, values) => {
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
          },
          action.values,
          { userGesture: true },
        );
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

  private clearDialog(): void {
    const dialog = this.dialog;
    this.dialog = undefined;
    if (dialog) {
      try {
        dialog.viewer.send({ type: 'dialog', target: this.id, dialog: null });
      } catch {
        /* The old carrier may already be gone. */
      }
    }
  }
  private clearFiles(): void {
    const chooser = this.chooser;
    this.chooser = undefined;
    if (chooser) {
      try {
        chooser.viewer.send({
          type: 'file_chooser',
          target: this.id,
          chooser: null,
        });
      } catch {
        /* The old carrier may already be gone. */
      }
    }
  }
  private dismissFiles(viewer?: Viewer): Promise<void> {
    const chooser = this.chooser;
    if (!chooser || (viewer && chooser.viewer !== viewer))
      return Promise.resolve();
    this.clearFiles();
    return Promise.all([
      chooser.batch.close(),
      chooser.source.respond(null).catch(() => {}),
    ]).then(() => {});
  }
  private dismissDialog(viewer?: Viewer): Promise<void> {
    const dialog = this.dialog;
    if (!dialog || (viewer && dialog.viewer !== viewer))
      return Promise.resolve();
    this.clearDialog();
    return dialog.source.respond(false).catch(() => {});
  }

  close(): Promise<void> {
    return (this.closing ??= this.dispose());
  }

  private async dispose(): Promise<void> {
    if (this.closed) return;
    if (this.viewer) this.viewer.active = false;
    for (const watcher of this.watchers) {
      try {
        watcher.send({
          type: 'media_end',
          target: this.id,
          view: watcher.view,
        });
      } catch {
        /* A disconnected viewer cannot receive retirement. */
      }
    }
    this.clearMedia();
    for (const watcher of this.watchers) watcher.active = false;
    this.watchers.clear();
    await this.dismissDialog();
    await this.dismissFiles();
    await this.page.setFileChooserIntercepted(false).catch(() => {});
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
    await this.ownedSource?.dispose();
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
  return [
    'navigate',
    'back',
    'forward',
    'reload',
    'stop',
    'viewport',
    'zoom',
    'dialog_reply',
    'file_reply',
  ].includes(action.kind);
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
