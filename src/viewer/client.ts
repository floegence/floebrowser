import { MediaView, type MediaAssets } from './media.js';
import { MediaPacketReader, type MediaFrame } from '../shared/media-wire.js';
import { ReplayPresentation } from './presentation.js';
import { liveEvent, liveScroll, svgStyles, mathElements } from './replay.js';
import { mapWheelPoint } from '../shared/wheel.js';
import { Replayer } from '@rrweb/replay';
import {
  EventType,
  IncrementalSource,
  ReplayerEvents,
  type eventWithTime,
} from '@rrweb/types';
import type {
  Action,
  FocusState,
  BrowserState,
  ProjectionConnection,
  ServerMessage,
  DisconnectReason,
  TabState,
} from '../shared/protocol.js';
import {
  DISCONNECT_CODES,
  MAX_PENDING_COMMANDS,
  MAX_VIEWPORT_DIMENSION,
  PROTOCOL_VERSION,
} from '../shared/protocol.js';

export type ViewportMode = 'responsive' | 'fit' | 'actual';

type ViewOptions = {
  /** Mount optional media controls in host browser chrome, outside the page. */
  mediaControls?: HTMLElement;
  mediaAssets?: MediaAssets;
  onState?: (state: BrowserState) => void;
  onStatus?: (
    status: 'connecting' | 'refreshing' | 'live' | 'disconnected',
    reason?: DisconnectReason,
  ) => void;
  onNotice?: (message: string) => void;
  onAction?: (milliseconds: number) => void;
  onAddressFocus?: () => void;
  onTabs?: (state: TabState) => void;
};
type Pending = {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  started: number;
  epoch: string;
  tab: string;
  hover: boolean;
  chrome: boolean;
  documentBound: boolean;
};
type Wheel = Extract<Action, { kind: 'wheel' }>;
const modifiers = (event: MouseEvent | KeyboardEvent) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

/** Renders inert DOM and returns user intent through a host-provided connection. */
export class DOMBrowserView {
  private replayer?: Replayer;
  private presentation?: ReplayPresentation;
  private media: MediaView;
  private epoch = '';
  private tab = '';
  private tabTitles = new Map<string, string>();
  private readiness = new Set<() => void>();
  private sequence = 0;
  private nextID = 0;
  private connected = false;
  private tabCommands = 0;
  private disconnectReason?: DisconnectReason;
  private ready = false;
  private destroyed = false;
  private resyncing = false;
  private eventBytes = 0;
  private pending = new Map<number, Pending>();
  private queuedWheel?: Wheel;
  private wheelsInFlight = 0;
  private sink: HTMLTextAreaElement;
  private surface: HTMLDivElement;
  private pageError: HTMLElement;
  private resize: ResizeObserver;
  private disposers: Array<() => void> = [];
  private frameDisposers: Array<() => void> = [];
  private inputDocuments = new WeakMap<Document, Element | null>();
  private viewport = { width: 1280, height: 800 };
  private viewportMode: ViewportMode = 'responsive';
  private viewportTimer?: ReturnType<typeof setTimeout>;
  private viewportPending?: Promise<boolean>;
  private requestedViewport = '';
  private composing = false;
  private suppressCompositionInput = false;
  private lastMove = 0;
  private dragging = false;
  private inputEngaged = false;
  private sourceFocus?: FocusState;

  constructor(
    private container: HTMLElement,
    private connection: ProjectionConnection,
    private options: ViewOptions = {},
  ) {
    container.classList.add('floe-viewport');
    this.surface = document.createElement('div');
    this.surface.className = 'floe-projection';
    this.sink = document.createElement('textarea');
    this.sink.className = 'floe-input-sink';
    this.sink.setAttribute('aria-label', 'Type in the source browser');
    this.sink.setAttribute('autocapitalize', 'off');
    this.sink.autocomplete = 'off';
    this.sink.spellcheck = false;
    container.append(this.surface, this.sink);
    this.pageError = document.createElement('section');
    this.pageError.className = 'floe-page-error';
    this.pageError.hidden = true;
    const heading = document.createElement('h1');
    heading.textContent = 'This page couldn’t be loaded';
    const explanation = document.createElement('p');
    explanation.textContent =
      'Check the address and your connection, or try opening another website.';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload page';
    this.listen(reload, 'click', () => {
      void this.dispatch({ kind: 'reload' });
    });
    this.pageError.append(heading, explanation, reload);
    container.append(this.pageError);
    this.media = new MediaView(
      options.mediaControls,
      (id, target) =>
        target === this.tab
          ? this.replayer?.getMirror().getNode(id)
          : undefined,
      (action, target, stream) => this.dispatchMedia(action, target, stream),
      (view, stream, target) => {
        if (this.connected && target)
          this.connection.send({
            type: 'media_keyframe',
            tab: target,
            view,
            stream,
          });
      },
      options.mediaAssets,
      (target) => this.tabTitles.get(target) ?? '',
    );
    this.disposers.push(
      connection.subscribe((message) => this.receive(message)),
      connection.onDisconnect((reason) => this.disconnected(reason)),
    );
    if (connection.subscribeMedia)
      this.disposers.push(
        connection.subscribeMedia((frame) => {
          if (this.connected) this.media.frame(frame);
        }),
      );
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(container);
    this.listen(this.sink, 'keydown', (event) =>
      this.key(event as KeyboardEvent, 'down'),
    );
    this.listen(this.sink, 'keyup', (event) =>
      this.key(event as KeyboardEvent, 'up'),
    );
    this.bindTextInput(this.sink);
    this.listen(document, 'focusin', (event) => {
      if (!this.container.contains(event.target as Node))
        this.inputEngaged = false;
    });
    this.listen(window, 'blur', () => {
      this.dragging = false;
    });
    this.options.onStatus?.('connecting');
  }

  private bindTextInput(target: EventTarget, frame = false): void {
    this.listen(
      target,
      'compositionstart',
      () => {
        this.composing = true;
      },
      frame,
    );
    this.listen(
      target,
      'compositionend',
      (event) => {
        this.composing = false;
        this.suppressCompositionInput = true;
        const text = (event as CompositionEvent).data;
        if (text) void this.dispatch({ kind: 'text', text });
        this.sink.value = '';
        queueMicrotask(() => {
          this.suppressCompositionInput = false;
        });
      },
      frame,
    );
    this.listen(
      target,
      'beforeinput',
      (event) => {
        const input = event as InputEvent;
        if (this.composing || input.isComposing) return;
        input.preventDefault();
        if (
          !this.suppressCompositionInput &&
          input.data &&
          input.inputType.startsWith('insert')
        )
          void this.dispatch({ kind: 'text', text: input.data });
        this.sink.value = '';
      },
      frame,
    );
    this.listen(
      target,
      'paste',
      (event) => {
        event.preventDefault();
        const text = (event as ClipboardEvent).clipboardData?.getData(
          'text/plain',
        );
        if (text) void this.dispatch({ kind: 'text', text });
      },
      frame,
    );
  }

  private applyFocus(): void {
    if (
      !this.inputEngaged ||
      this.composing ||
      !this.sourceFocus ||
      !this.replayer
    )
      return;
    const element = this.replayer.getMirror().getNode(this.sourceFocus.node) as
      HTMLInputElement | HTMLTextAreaElement | null;
    if (
      !element?.isConnected ||
      !['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
    )
      return;
    element.focus({ preventScroll: true });
    if (
      this.sourceFocus.start !== null &&
      this.sourceFocus.end !== null &&
      'setSelectionRange' in element
    ) {
      try {
        element.setSelectionRange(
          this.sourceFocus.start,
          this.sourceFocus.end,
          this.sourceFocus.direction ?? 'none',
        );
      } catch {
        /* Non-text controls do not expose a selection range. */
      }
    }
  }

  private listen(
    target: EventTarget,
    name: string,
    listener: EventListener,
    frame = false,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(name, listener, options);
    (frame ? this.frameDisposers : this.disposers).push(() =>
      target.removeEventListener(name, listener, options),
    );
  }

  private async dispatchMedia(
    action: Action,
    target?: string,
    stream?: string,
  ): Promise<boolean> {
    if (!target || target === this.tab) return this.dispatch(action);
    if (!(await this.dispatch({ kind: 'tab_select', tab: target })))
      return false;
    const ready = await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.readiness.delete(changed);
        resolve(ok);
      };
      const changed = () => {
        if (!this.connected || this.destroyed || this.tab !== target)
          done(false);
        else if (this.ready) done(true);
      };
      const timer = setTimeout(() => done(false), 10000);
      this.readiness.add(changed);
      changed();
    });
    if (!ready || action.kind !== 'media' || !stream) return ready;
    const node = this.media.nodeID(target, stream);
    return node !== undefined && this.dispatch({ ...action, node });
  }
  private receive(message: ServerMessage): void {
    try {
      this.receiveMessage(message);
    } finally {
      for (const changed of this.readiness) changed();
    }
  }
  private receiveMessage(message: ServerMessage): void {
    if (this.destroyed) return;
    if (message.type === 'media_end') {
      this.media.end(message.target, message.view);
      return;
    }
    if (message.type === 'media') {
      if (this.connected)
        this.media.receive(message.packet, {
          target: message.target,
          view: message.view,
        });
      return;
    }
    if (message.type === 'tabs') {
      this.tabTitles = new Map(
        message.state.tabs.map((tab) => [tab.id, tab.title || tab.url]),
      );
      if (message.state.active !== this.tab) {
        for (const [id, pending] of this.pending) {
          if (pending.chrome) continue;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(false);
        }
        this.ready = false;
        this.pageError.hidden = true;
        this.queuedWheel = undefined;
        this.clearFrame();
        this.presentation?.dispose();
        this.replayer?.destroy();
        this.replayer = undefined;
        this.tab = message.state.active;
        this.media.select(this.tab);
        this.epoch = '';
        this.options.onStatus?.(this.connected ? 'refreshing' : 'connecting');
      }
      this.options.onTabs?.(message.state);
      return;
    }
    if (message.type === 'hello') {
      if (message.version !== PROTOCOL_VERSION) {
        this.options.onNotice?.(
          'This viewer and source use different protocol versions.',
        );
        this.connection.close();
        return;
      }
      this.connected = true;
      // Browser controls depend on the carrier, not on a selected renderer
      // producing its first snapshot (including reconnecting to a hung tab).
      this.options.onStatus?.('refreshing');
      return;
    }
    if (message.type === 'focus') {
      if (message.epoch === this.epoch) {
        this.sourceFocus = message.focus;
        this.applyFocus();
      }
      return;
    }
    if (message.type === 'state') {
      if (this.tab !== message.state.id) this.queuedWheel = undefined;
      this.tab = message.state.id;
      this.viewport = {
        width: message.state.width,
        height: message.state.height,
      };
      if (message.state.status !== 'ready') {
        this.presentation?.dispose();
        this.ready = false;
        this.queuedWheel = undefined;
      }
      this.pageError.hidden = message.state.status !== 'error';
      if (message.state.status === 'error') {
        this.epoch = '';
        this.resyncing = false;
        this.sourceFocus = undefined;
        this.clearFrame();
        this.presentation?.dispose();
        this.replayer?.destroy();
        this.replayer = undefined;
        this.surface.replaceChildren();
        // The connection and browser chrome remain usable without website DOM.
        this.options.onStatus?.('live');
      }
      this.options.onState?.(message.state);
      this.layout();
      if (message.state.status === 'closed') {
        this.disconnected('source_unavailable');
        this.connection.close();
      }
      return;
    }
    if (message.type === 'snapshot') {
      this.ready = false;
      this.pageError.hidden = true;
      this.queuedWheel = undefined;
      this.epoch = message.epoch;
      this.sequence = message.sequence;
      this.resyncing = false;
      this.eventBytes = 0;
      this.sourceFocus = undefined;
      this.clearFrame();
      this.presentation?.dispose();
      this.replayer?.destroy();
      this.surface.style.opacity = '0';
      this.surface.style.visibility = 'hidden';
      this.surface.inert = true;
      this.options.onStatus?.('refreshing');
      const presentation = new ReplayPresentation(
        async () => {
          const current = () =>
            this.connected &&
            !this.destroyed &&
            presentation.active &&
            this.presentation === presentation;
          if (!current()) return;
          // Settle initial responsive sizing before exposing clickable content.
          // Otherwise its scale can change between mouse down and mouse up.
          if (this.viewportPending) await this.viewportPending;
          while (current() && this.viewportMode === 'responsive') {
            const resized = this.resizeViewport();
            if (!resized) break;
            await resized;
          }
          if (!current()) return;
          this.installInput();
          this.ready = true;
          this.layout();
          this.surface.style.opacity = '';
          this.surface.style.visibility = '';
          this.surface.inert = false;
          this.applyFocus();
          this.options.onStatus?.('live');
          for (const changed of this.readiness) changed();
        },
        () =>
          this.options.onNotice?.(
            'Some page styles took too long to load. Reload the page if it looks incomplete.',
          ),
      );
      this.presentation = presentation;
      const now = Date.now();
      this.replayer = new Replayer([], {
        root: this.surface,
        liveMode: true,
        // A live projection must not freeze entry animations at their first frame.
        pauseAnimation: false,
        showWarning: false,
        showDebug: false,
        mouseTail: false,
        triggerFocus: false,
        plugins: [
          liveScroll,
          svgStyles,
          mathElements,
          {
            onBuild: (node) => {
              if ('getRootNode' in node) presentation.build(node as Node);
              if (node.nodeName === 'HTML')
                this.bindFrameDocuments(node.ownerDocument as Document);
            },
          },
        ],
        insertStyleRules: [
          ':not([data-floebrowser-canvas])[data-floebrowser-unsupported]{display:flex!important;align-items:center;justify-content:center;background:#f3f5f8!important;border:1px dashed #c9d1dd!important;color:#64748b!important;font:12px/1.5 system-ui!important;overflow:hidden}',
          ':not([data-floebrowser-canvas])[data-floebrowser-unsupported]::after{content:attr(data-floebrowser-unsupported);padding:12px;text-align:center}',
          'a,button,select,input[type=checkbox],input[type=radio]{cursor:pointer}',
        ],
      });
      this.replayer.on(ReplayerEvents.FullsnapshotRebuilded, () => {
        presentation.start();
      });
      this.replayer.on(ReplayerEvents.EventCast, (raw) => {
        const event = raw as eventWithTime;
        if (
          event.type === EventType.FullSnapshot ||
          (event.type === EventType.IncrementalSnapshot &&
            event.data.source === IncrementalSource.Mutation)
        ) {
          this.bindFrameDocuments();
          this.applyFocus();
        } else if (
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Input
        ) {
          this.applyFocus();
        }
      });
      this.replayer.startLive(now);
      for (const event of message.events)
        this.replayer.addEvent(liveEvent(event, now));
      return;
    }
    if (message.type === 'events') {
      if (this.resyncing) return;
      if (
        !this.replayer ||
        message.epoch !== this.epoch ||
        message.sequence !== this.sequence + 1
      ) {
        this.resync();
        return;
      }
      this.sequence = message.sequence;
      const now = Date.now();
      for (const event of message.events)
        this.replayer.addEvent(liveEvent(event, now));
      this.eventBytes += JSON.stringify(message.events).length;
      if (this.eventBytes > 8 * 1024 * 1024 || this.sequence > 4000)
        this.resync();
      return;
    }
    if (message.type === 'ack') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message.ok);
      this.options.onAction?.(Math.round(performance.now() - pending.started));
      if (!message.ok) {
        if (!pending.chrome && pending.tab !== this.tab) return;
        // Hover has no confirmed user effect. Likewise, an old document's
        // late failure must not interrupt the page that replaced it.
        if (
          pending.hover ||
          (pending.documentBound && pending.epoch !== this.epoch)
        )
          return;
        if (message.code === 'navigation_failed' && !this.pageError.hidden)
          return;
        if (message.code === 'stale_view') {
          // Hover can overtake a changing DOM without a user action failing.
          // A rejected action refreshes only its current view, never its input.
          if (
            pending.epoch !== this.epoch ||
            pending.tab !== this.tab ||
            this.resyncing
          )
            return;
          this.resync();
        }
        const text = {
          stale_view:
            'The page changed before that action. Please try again on the current view.',
          target_unavailable: 'The source page is unavailable.',
          unsupported: 'This control is not supported in DOM mode.',
          action_failed:
            'The source could not confirm that action. It has not been repeated.',
          navigation_failed:
            'This page couldn’t be loaded. Check the address or try again.',
          busy: 'The source is catching up. Please wait a moment.',
          not_allowed: 'The host did not authorize that action.',
        };
        this.options.onNotice?.(text[message.code ?? 'action_failed']);
      }
      return;
    }
    if (message.type === 'notice') this.options.onNotice?.(message.message);
  }

  private resync(): void {
    if (this.resyncing || !this.connected) return;
    this.resyncing = true;
    this.ready = false;
    this.queuedWheel = undefined;
    this.options.onStatus?.(this.replayer ? 'refreshing' : 'connecting');
    this.connection.send({ type: 'resync' });
  }

  dispatch(action: Action): Promise<boolean> {
    if (action.kind === 'tab_move') return this.sendAction(action);
    if (action.kind.startsWith('tab_')) {
      this.queuedWheel = undefined;
      this.tabCommands++;
      return this.sendAction(action).finally(() => {
        this.tabCommands--;
        this.scheduleViewport();
      });
    }
    // A click, key, navigation or other action is an ordering barrier.
    this.flushWheel();
    return this.sendAction(action);
  }

  private queueWheel(action: Wheel): void {
    if (!this.connected || !this.ready || this.tabCommands) return;
    const prior = this.queuedWheel;
    if (
      prior &&
      prior.point.node === action.point.node &&
      prior.point.x === action.point.x &&
      prior.point.y === action.point.y &&
      prior.modifiers === action.modifiers &&
      Math.sign(prior.dx) === Math.sign(action.dx) &&
      Math.sign(prior.dy) === Math.sign(action.dy) &&
      Math.abs(prior.dx + action.dx) <= 4000 &&
      Math.abs(prior.dy + action.dy) <= 4000
    ) {
      prior.dx += action.dx;
      prior.dy += action.dy;
    } else {
      this.flushWheel();
      this.queuedWheel = action;
    }
    if (!this.wheelsInFlight) this.flushWheel();
  }

  private flushWheel(): void {
    const action = this.queuedWheel;
    if (!action) return;
    this.queuedWheel = undefined;
    const epoch = this.epoch;
    const tab = this.tab;
    this.wheelsInFlight++;
    void this.sendAction(action).then((ok) => {
      this.wheelsInFlight--;
      // Merge only unsent input. An uncertain/rejected gesture is never retried.
      if (!ok && epoch === this.epoch && tab === this.tab)
        this.queuedWheel = undefined;
      if (!this.wheelsInFlight) this.flushWheel();
    });
  }

  private sendAction(action: Action): Promise<boolean> {
    if (
      !this.connected ||
      (this.tabCommands > 0 && !action.kind.startsWith('tab_')) ||
      (!this.ready &&
        ![
          'navigate',
          'back',
          'forward',
          'reload',
          'viewport',
          'tab_new',
          'tab_select',
          'tab_close',
          'tab_move',
        ].includes(action.kind))
    )
      return Promise.resolve(false);
    if (action.kind === 'text' && action.text.length > 16000) {
      this.options.onNotice?.('Paste up to 16,000 characters at a time.');
      return Promise.resolve(false);
    }
    const chrome = action.kind.startsWith('tab_');
    if (
      [...this.pending.values()].filter((pending) => pending.chrome === chrome)
        .length >= MAX_PENDING_COMMANDS
    ) {
      this.options.onNotice?.(
        'The source is catching up. Please wait a moment.',
      );
      return Promise.resolve(false);
    }
    const id = ++this.nextID;
    const tab = this.tab;
    const epoch = this.epoch;
    const hover =
      action.kind === 'pointer' &&
      action.phase === 'move' &&
      action.buttons === 0;
    const documentBound = [
      'pointer',
      'wheel',
      'key',
      'text',
      'select',
      'media',
    ].includes(action.kind);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
        if (
          !hover &&
          (!documentBound || epoch === this.epoch) &&
          (chrome || this.tab === tab)
        )
          this.options.onNotice?.(
            'This page did not confirm the action. You can switch tabs or close it. The action has not been repeated.',
          );
      }, 25000);
      this.pending.set(id, {
        resolve,
        timer,
        started: performance.now(),
        epoch: this.epoch,
        tab: this.tab,
        chrome,
        documentBound,
        hover,
      });
      try {
        this.connection.send({
          type: 'command',
          id,
          tab: this.tab,
          epoch: this.epoch,
          action,
        });
      } catch {
        this.disconnected();
      }
    });
  }

  setFit(fit: boolean): void {
    this.setViewportMode(fit ? 'fit' : 'actual');
  }
  setViewportMode(mode: ViewportMode): void {
    this.viewportMode = mode;
    this.requestedViewport = '';
    this.layout();
  }

  private scheduleViewport(): void {
    clearTimeout(this.viewportTimer);
    if (
      this.destroyed ||
      !this.connected ||
      !this.ready ||
      this.tabCommands > 0 ||
      this.viewportMode !== 'responsive'
    )
      return;
    // Keep one in-flight resize and coalesce a drag to its latest dimensions.
    this.viewportTimer = setTimeout(() => {
      if (
        this.viewportPending ||
        !this.connected ||
        !this.ready ||
        this.tabCommands
      )
        return;
      void this.resizeViewport();
    }, 80);
  }
  private resizeViewport(): Promise<boolean> | undefined {
    if (this.viewportPending) return this.viewportPending;
    const width = Math.min(MAX_VIEWPORT_DIMENSION, this.container.clientWidth);
    const height = Math.min(
      MAX_VIEWPORT_DIMENSION,
      this.container.clientHeight,
    );
    if (
      width < 1 ||
      height < 1 ||
      this.tabCommands ||
      (width === this.viewport.width && height === this.viewport.height)
    )
      return;
    const request = `${this.tab}:${width}:${height}`;
    if (request === this.requestedViewport) return;
    this.requestedViewport = request;
    this.viewportPending = this.dispatch({
      kind: 'viewport',
      width,
      height,
    }).finally(() => {
      this.viewportPending = undefined;
      // A changed size/tab is fresh intent. Failed dimensions are not retried.
      this.scheduleViewport();
    });
    return this.viewportPending;
  }
  private layout(): void {
    this.container.dataset.viewportMode = this.viewportMode;
    // State confirms source sizing before rrweb's sampled resize event arrives.
    // Keep the replay viewport and its coordinate transform in the same layout.
    if (this.replayer) {
      this.replayer.iframe.width = String(this.viewport.width);
      this.replayer.iframe.height = String(this.viewport.height);
    }
    const scale =
      this.viewportMode !== 'actual'
        ? Math.min(
            1,
            this.container.clientWidth / this.viewport.width,
            this.container.clientHeight / this.viewport.height,
          )
        : 1;
    this.surface.style.width = `${this.viewport.width}px`;
    this.surface.style.height = `${this.viewport.height}px`;
    this.surface.style.transform = `scale(${scale})`;
    this.surface.style.left =
      this.viewportMode === 'responsive'
        ? '0px'
        : `${Math.max(0, (this.container.clientWidth - this.viewport.width * scale) / 2)}px`;
    this.surface.style.top =
      this.viewportMode === 'fit'
        ? `${Math.max(0, (this.container.clientHeight - this.viewport.height * scale) / 2)}px`
        : '0px';
    this.scheduleViewport();
  }

  private point(
    event: MouseEvent,
  ): { node: number; x: number; y: number } | undefined {
    const target = event
      .composedPath()
      .find((item) => (item as Node)?.nodeType === 1) as Element | undefined;
    if (!target || target.closest('[data-floebrowser-unsupported]')) return;
    const node = this.replayer!.getMirror().getId(target);
    const rect = target.getBoundingClientRect();
    if (node < 1 || !rect.width || !rect.height) return;
    return {
      node,
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  private installInput(): void {
    this.clearFrame();
    const player = this.replayer!;
    player.enableInteract();
    player.iframe.setAttribute('scrolling', 'no');
    this.bindFrameDocuments();
  }

  private bindFrameDocuments(
    frame = this.replayer?.iframe.contentDocument,
  ): void {
    if (!frame) return;
    if (
      !this.inputDocuments.has(frame) ||
      this.inputDocuments.get(frame) !== frame.documentElement
    ) {
      this.inputDocuments.set(frame, frame.documentElement);
      this.bindDocumentInput(frame);
    }
    for (const child of frame.querySelectorAll('iframe,frame'))
      this.bindFrameDocuments((child as HTMLIFrameElement).contentDocument);
  }

  private bindDocumentInput(frame: Document): void {
    const player = this.replayer!;
    this.bindTextInput(frame, true);
    this.listen(
      frame,
      'mousedown',
      (raw) => {
        this.media.interact(raw);
        const event = raw as PointerEvent;
        this.inputEngaged = true;
        this.sourceFocus = undefined;
        const target = event.target as Element;
        if (target.closest('select')) return;
        const point = this.point(event);
        if (!point) return;
        if (
          target.closest(
            '[data-floebrowser-editable],[data-floebrowser-canvas]',
          )
        )
          event.preventDefault();
        this.dragging = true;
        void this.dispatch({
          kind: 'pointer',
          phase: 'down',
          point,
          button: mouseButton(event.button),
          buttons: event.buttons,
          modifiers: modifiers(event),
          clicks: Math.max(1, Math.min(3, event.detail || 1)),
        });
      },
      true,
    );
    this.listen(
      frame,
      'mouseup',
      (raw) => {
        const event = raw as PointerEvent;
        if ((event.target as Element).closest('select')) return;
        const point = this.point(event);
        this.dragging = false;
        if (point)
          void this.dispatch({
            kind: 'pointer',
            phase: 'up',
            point,
            button: mouseButton(event.button),
            buttons: event.buttons,
            modifiers: modifiers(event),
            clicks: Math.max(1, Math.min(3, event.detail || 1)),
          });
        if (
          frame.getSelection()?.isCollapsed !== false &&
          !(event.target as Element).closest('input,textarea,select')
        )
          this.sink.focus({ preventScroll: true });
      },
      true,
    );
    this.listen(
      frame,
      'mousemove',
      (raw) => {
        const event = raw as PointerEvent;
        if (!this.dragging && performance.now() - this.lastMove < 40) return;
        this.lastMove = performance.now();
        const point = this.point(event);
        if (!point) return;
        void this.dispatch({
          kind: 'pointer',
          phase: 'move',
          point,
          button: 'left',
          buttons: this.dragging ? event.buttons : 0,
          modifiers: modifiers(event),
          clicks: 1,
        });
      },
      true,
    );
    this.listen(
      frame,
      'click',
      (event) => {
        if (!(event.target as Element).closest('select'))
          event.preventDefault();
      },
      true,
    );
    this.listen(frame, 'submit', (event) => event.preventDefault(), true);
    this.listen(frame, 'contextmenu', (event) => event.preventDefault(), true);
    this.listen(
      frame,
      'wheel',
      (raw) => {
        raw.preventDefault();
        const event = raw as WheelEvent;
        const target = event
          .composedPath()
          .find((item) => (item as Node)?.nodeType === 1) as
          Element | undefined;
        if (!target) return;
        const mapped = mapWheelPoint(target, {
          space: 'client',
          x: event.clientX,
          y: event.clientY,
          dx: event.deltaX,
          dy: event.deltaY,
        });
        if (!mapped?.node) return;
        const node = player.getMirror().getId(mapped.node);
        if (node < 1) return;
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? this.viewport.height
              : 1;
        this.queueWheel({
          kind: 'wheel',
          point: { space: 'viewport', node, x: mapped.x, y: mapped.y },
          dx: Math.max(-4000, Math.min(4000, event.deltaX * unit)),
          dy: Math.max(-4000, Math.min(4000, event.deltaY * unit)),
          modifiers: modifiers(event),
        });
      },
      true,
      { passive: false },
    );
    this.listen(
      frame,
      'keydown',
      (event) => this.key(event as KeyboardEvent, 'down'),
      true,
    );
    this.listen(
      frame,
      'keyup',
      (event) => this.key(event as KeyboardEvent, 'up'),
      true,
    );
    this.listen(
      frame,
      'change',
      (event) => {
        const select = event.target as HTMLSelectElement;
        if (select.tagName === 'SELECT')
          void this.dispatch({
            kind: 'select',
            node: player.getMirror().getId(select),
            values: Array.from(select.selectedOptions).map(
              (option) => option.value,
            ),
          });
      },
      true,
    );
  }

  private key(event: KeyboardEvent, phase: 'down' | 'up'): void {
    if (phase === 'down') this.media.interact(event);
    if (this.composing || event.isComposing || event.key === 'Process') return;
    if (
      (event.ctrlKey || event.metaKey) &&
      ['l', 'r'].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (phase === 'down') {
        if (event.key.toLowerCase() === 'l') this.options.onAddressFocus?.();
        else void this.dispatch({ kind: 'reload' });
      }
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c' &&
      this.replayer?.iframe.contentDocument?.getSelection()?.isCollapsed ===
        false
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v')
      return;
    event.preventDefault();
    void this.dispatch({
      kind: 'key',
      phase,
      key: event.key,
      code: event.code,
      modifiers: modifiers(event),
    });
  }

  private disconnected(reason?: DisconnectReason): void {
    clearTimeout(this.viewportTimer);
    this.queuedWheel = undefined;
    this.media.reset();
    this.disconnectReason = reason ?? this.disconnectReason;
    this.connected = false;
    this.ready = false;
    this.dragging = false;
    this.presentation?.dispose();
    this.options.onStatus?.('disconnected', this.disconnectReason);
    for (const changed of this.readiness) changed();
    if (this.pending.size)
      this.options.onNotice?.(
        'Connection lost. Unconfirmed actions have not been repeated.',
      );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pending.clear();
  }
  private clearFrame(): void {
    this.inputDocuments = new WeakMap();
    for (const dispose of this.frameDisposers.splice(0)) dispose();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disconnected();
    this.clearFrame();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.resize.disconnect();
    this.media.destroy();
    this.replayer?.destroy();
    this.connection.close();
    this.container.replaceChildren();
  }
}
function mouseButton(button: number): 'left' | 'middle' | 'right' {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
}

/** No automatic reconnect and no command replay. Reconnect creates a fresh view. */
export function webSocketConnection(url: string): ProjectionConnection {
  const socket = new WebSocket(url);
  let media: WebSocket | undefined;
  const mediaListeners = new Set<(frame: MediaFrame) => void>();
  const messages = new Set<(message: ServerMessage) => void>();
  const disconnected = new Set<(reason?: DisconnectReason) => void>();
  socket.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data);
      if (parsed.type === 'carrier') {
        if (
          media ||
          typeof parsed.mediaToken !== 'string' ||
          !/^[\w-]{43}$/.test(parsed.mediaToken)
        )
          throw new Error('Invalid carrier');
        const address = new URL(url, location.href);
        address.pathname = address.pathname.replace(/stream$/, 'media');
        address.search = `?token=${parsed.mediaToken}`;
        media = new WebSocket(address);
        media.binaryType = 'arraybuffer';
        const reader = new MediaPacketReader();
        let consumed = 0;
        media.onmessage = ({ data }) => {
          if (!(data instanceof ArrayBuffer)) {
            media?.close(1008);
            return;
          }
          try {
            for (const frame of reader.push(new Uint8Array(data))) {
              for (const listener of mediaListeners) listener(frame);
              const ack = new Uint8Array(8);
              new DataView(ack.buffer).setBigUint64(0, BigInt(++consumed));
              media!.send(ack);
            }
          } catch {
            media?.close(1008);
          }
        };
        return;
      }
      const message: ServerMessage = parsed;
      for (const listener of messages) listener(message);
    } catch {
      socket.close(1008, 'Invalid projection');
    }
  });
  socket.addEventListener('close', (event) => {
    media?.close();
    const reason = (Object.keys(DISCONNECT_CODES) as DisconnectReason[]).find(
      (reason) => DISCONNECT_CODES[reason] === event.code,
    );
    for (const listener of disconnected) listener(reason);
  });
  return {
    send: (message) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Disconnected');
      socket.send(JSON.stringify(message));
    },
    subscribe: (listener) => {
      messages.add(listener);
      return () => {
        messages.delete(listener);
      };
    },
    subscribeMedia: (listener) => {
      mediaListeners.add(listener);
      return () => {
        mediaListeners.delete(listener);
      };
    },
    onDisconnect: (listener) => {
      disconnected.add(listener);
      return () => {
        disconnected.delete(listener);
      };
    },
    close: () => {
      media?.close();
      socket.close();
    },
  };
}
