import { MediaView, type MediaAssets } from './media.js';
import {
  browserText,
  type BrowserMessages,
  type BrowserText,
} from './messages.js';
import {
  MEDIA_WIRE_VERSION,
  MediaPacketReader,
  type MediaFrame,
} from '../shared/media-wire.js';
import { InputFonts } from './input-fonts.js';
import { INPUT_PROXY_ATTRIBUTE } from '../shared/style.js';
import { replayHit, styleInputProxy } from './input-geometry.js';
import { ReplayPresentation } from './presentation.js';
import { ReplayPages } from './replay-pages.js';
import { ReplayResources, type ResourceFetch } from './resources.js';
import {
  liveEvents,
  liveFrameDocuments,
  liveScroll,
  liveSelection,
  svgStyles,
  mathElements,
} from './replay.js';
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
  DialogState,
  FileChooserState,
  DownloadState,
} from '../shared/protocol.js';
import {
  DISCONNECT_CODES,
  MAX_PENDING_COMMANDS,
  MAX_VIEWPORT_DIMENSION,
  PROTOCOL_VERSION,
} from '../shared/protocol.js';

export type ViewportMode = 'responsive' | 'fit' | 'actual';

export type ViewOptions = {
  /** Reads only host-issued same-origin resource URLs in the trusted document.
   * Defaults to fetch; authenticated hosts may route it through their carrier. */
  fetchResource?: ResourceFetch;
  messages?: BrowserMessages;
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
  onControl?: (controlling: boolean) => void;
  onSessionAccess?: (editTabs: boolean, restoreTabs: boolean) => void;
  onAddressFocus?: () => void;
  /** Return true for a browser-chrome shortcut consumed by the embedding host. */
  onShortcut?: (event: KeyboardEvent, phase: 'down' | 'up') => boolean;
  onTabs?: (state: TabState) => void;
  /** Website-native dialogs are delivered only to the active source controller. */
  onDialog?: (dialog: DialogState | null) => void;
  onFileChooser?: (chooser: FileChooserState | null) => void;
  onDownloads?: (target: string, downloads: DownloadState[]) => void;
  onFind?: (result: { query: string; found: boolean }) => void;
};
type Pending = {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  expire: () => void;
  started: number;
  epoch: string;
  tab: string;
  quiet: boolean;
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
  private pages: ReplayPages;
  private tabURLs = new Map<string, string>();
  private documentURL = '';
  private previewTarget?: string;
  private presentation?: ReplayPresentation;
  private resources?: ReplayResources;
  private media: MediaView;
  private text: BrowserText;
  private epoch = '';
  private tab = '';
  private tabTitles = new Map<string, string>();
  private readiness = new Set<() => void>();
  private sequence = 0;
  private nextID = 0;
  private connected = false;
  private incompatible = false;
  private controlled = false;
  private editTabs = true;
  private restoreTabs = true;
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
  private inputSurface: HTMLDivElement;
  private inputProxy?: {
    node: Element;
    control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  };
  private compositionAuthority?: string;
  private heldInput = false;
  private viewport = { width: 1280, height: 800 };
  private zoom = 1;
  private fileChooser: FileChooserState | null = null;
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
  private inputFonts = new InputFonts();
  private focusFrame = 0;
  private dialogOpen = false;
  private directoryDialog?: string;

  constructor(
    private container: HTMLElement,
    private connection: ProjectionConnection,
    private options: ViewOptions = {},
  ) {
    this.text = browserText(options.messages);
    container.classList.add('floe-viewport');
    this.pages = new ReplayPages(container);
    this.surface = this.pages.create();
    this.sink = document.createElement('textarea');
    this.sink.className = 'floe-input-sink';
    this.sink.setAttribute('aria-label', this.text('page.input'));
    this.sink.setAttribute('autocapitalize', 'off');
    this.sink.autocomplete = 'off';
    this.sink.spellcheck = false;
    this.inputSurface = document.createElement('div');
    this.inputSurface.className = 'floe-input-surface';
    container.append(this.inputSurface, this.sink);
    this.pageError = document.createElement('section');
    this.pageError.className = 'floe-page-error';
    this.pageError.hidden = true;
    const heading = document.createElement('h1');
    heading.textContent = this.text('page.failed');
    const explanation = document.createElement('p');
    explanation.textContent = this.text('page.recovery');
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = this.text('page.reload');
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
      this.text,
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
    this.bindInput();
    this.listen(document, 'focusin', (event) => {
      if (!this.container.contains(event.target as Node)) {
        this.inputEngaged = false;
        this.cancelInput();
        this.clearProxy();
      }
    });
    this.listen(window, 'blur', () => this.cancelInput());
    this.options.onStatus?.('connecting');
  }

  private authority(): string {
    return `${this.tab}:${this.epoch}:${this.controlled}`;
  }

  private bindTextInput(target: EventTarget): void {
    this.listen(target, 'compositionstart', () => {
      this.composing = true;
      this.compositionAuthority = this.authority();
    });
    this.listen(target, 'compositionend', (event) => {
      const current = this.compositionAuthority === this.authority();
      this.composing = false;
      this.compositionAuthority = undefined;
      this.suppressCompositionInput = true;
      const text = (event as CompositionEvent).data;
      if (current && text) void this.dispatch({ kind: 'text', text });
      this.sink.value = '';
      queueMicrotask(() => {
        this.suppressCompositionInput = false;
      });
    });
    this.listen(target, 'beforeinput', (event) => {
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
    });
    this.listen(target, 'paste', (event) => {
      event.preventDefault();
      const text = (event as ClipboardEvent).clipboardData?.getData(
        'text/plain',
      );
      if (text) void this.dispatch({ kind: 'text', text });
    });
    this.listen(target, 'copy', (event) => {
      event.preventDefault();
      if (!this.ready || !this.controlled) return;
      const clipboard = (event as ClipboardEvent).clipboardData;
      if (!clipboard) return;
      const selected = this.selectedText();
      if (selected !== undefined) clipboard.setData('text/plain', selected);
    });
  }

  private selectedText(): string | undefined {
    const focused =
      this.sourceFocus &&
      (this.replayer?.getMirror().getNode(this.sourceFocus.node) as
        HTMLInputElement | HTMLTextAreaElement | undefined);
    if (
      focused?.isConnected &&
      ['INPUT', 'TEXTAREA'].includes(focused.tagName)
    ) {
      if (focused.type === 'password') return;
      const { start, end } = this.sourceFocus!;
      if (start !== null && end !== null)
        return focused.value.slice(start, end);
    }
    const visit = (doc?: Document | null): string | undefined => {
      if (!doc) return;
      const selection = doc.getSelection();
      if (selection && !selection.isCollapsed) return selection.toString();
      for (const frame of doc.querySelectorAll('iframe,frame')) {
        const text = visit((frame as HTMLIFrameElement).contentDocument);
        if (text !== undefined) return text;
      }
    };
    return visit(this.replayer?.iframe.contentDocument);
  }

  private clearProxy(): void {
    this.inputFonts.clear();
    this.inputProxy?.node.removeAttribute(INPUT_PROXY_ATTRIBUTE);
    this.inputProxy?.control.remove();
    this.inputProxy = undefined;
  }

  private proxyFor(
    element: Element,
  ): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined {
    if (this.inputProxy?.node === element) return this.inputProxy.control;
    this.clearProxy();
    const doc = this.container.ownerDocument;
    let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (element.tagName === 'SELECT') {
      const source = element as HTMLSelectElement;
      control = doc.createElement('select');
      control.multiple = source.multiple;
      control.size = source.size;
      control.disabled = source.disabled;
      const options = (source: Element, target: Element) => {
        for (const child of source.children) {
          if (child.tagName === 'OPTGROUP') {
            const group = doc.createElement('optgroup');
            group.label = (child as HTMLOptGroupElement).label;
            group.disabled = (child as HTMLOptGroupElement).disabled;
            options(child, group);
            target.append(group);
          } else if (child.tagName === 'OPTION') {
            const original = child as HTMLOptionElement;
            const option = doc.createElement('option');
            option.textContent = original.label;
            option.value = original.value;
            option.disabled = original.disabled;
            option.selected = original.selected;
            target.append(option);
          }
        }
      };
      options(source, control);
      const authority = this.authority();
      const node = this.replayer!.getMirror().getId(element);
      control.addEventListener('change', () => {
        if (authority !== this.authority() || !element.isConnected) return;
        void this.dispatch({
          kind: 'select',
          node,
          values: Array.from(
            (control as HTMLSelectElement).selectedOptions,
          ).map((option) => option.value),
        });
      });
    } else if (element.tagName === 'TEXTAREA') {
      control = doc.createElement('textarea');
      control.wrap = (element as HTMLTextAreaElement).wrap;
    } else if (
      element.tagName === 'INPUT' &&
      /^(text|search|url|tel|email|password|number)$/.test(
        (element as HTMLInputElement).type,
      )
    ) {
      control = doc.createElement('input');
      control.type = (element as HTMLInputElement).type;
    } else return;
    control.className = 'floe-input-proxy';
    control.setAttribute(
      'aria-label',
      element.getAttribute('aria-label') ||
        Array.from((element as HTMLInputElement).labels ?? [])
          .map((label) => label.textContent?.trim())
          .filter(Boolean)
          .join(' ') ||
        this.text('page.input'),
    );
    if (control.tagName !== 'SELECT') {
      control.autocomplete = 'off';
      control.spellcheck = false;
      (control as HTMLInputElement).placeholder = (
        element as HTMLInputElement
      ).placeholder;
      control.setAttribute('autocapitalize', 'off');
      (control as HTMLInputElement).readOnly = (
        element as HTMLInputElement
      ).readOnly;
    }
    this.inputSurface.append(control);
    this.inputProxy = { node: element, control };
    styleInputProxy(control, element as HTMLElement, this.container);
    this.inputFonts.apply(control, element);
    return control;
  }

  private applyFocus(): void {
    if (this.focusFrame) return;
    this.focusFrame = requestAnimationFrame(() => {
      this.focusFrame = 0;
      this.syncFocus();
    });
  }

  private syncFocus(): void {
    if (
      !this.inputEngaged ||
      this.composing ||
      !this.sourceFocus ||
      !this.replayer ||
      !this.ready
    )
      return;
    const element = this.replayer
      .getMirror()
      .getNode(this.sourceFocus.node) as HTMLElement | null;
    if (!element?.isConnected) {
      this.clearProxy();
      this.sink.focus({ preventScroll: true });
      return;
    }
    // A native picker opened from hover must not be replaced by an unrelated
    // delayed focus update while the user chooses an option.
    if (
      this.inputProxy?.control.tagName === 'SELECT' &&
      this.inputProxy.node !== element
    )
      return;
    const proxy = this.proxyFor(element);
    if (!proxy) {
      this.sink.focus({ preventScroll: true });
      return;
    }
    styleInputProxy(proxy, element, this.container);
    this.inputFonts.apply(proxy, element);
    if (proxy.tagName !== 'SELECT') {
      const text = proxy as HTMLInputElement | HTMLTextAreaElement;
      const source = element as HTMLInputElement | HTMLTextAreaElement;
      text.value = source.value;
      if (this.sourceFocus.start !== null && this.sourceFocus.end !== null) {
        try {
          text.setSelectionRange(
            this.sourceFocus.start,
            this.sourceFocus.end,
            this.sourceFocus.direction ?? 'none',
          );
        } catch {
          /* Non-text controls do not expose a selection range. */
        }
      }
      text.scrollLeft = source.scrollLeft;
      text.scrollTop = source.scrollTop;
    }
    proxy.focus({ preventScroll: true });
  }

  private listen(
    target: EventTarget,
    name: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(name, listener, options);
    this.disposers.push(() =>
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
    if (this.destroyed || this.incompatible) return;
    if (message.type === 'downloads') {
      this.options.onDownloads?.(message.target, message.items);
      return;
    }
    if (message.type === 'file_chooser') {
      if (
        message.target === this.tab &&
        (!message.chooser || this.controlled)
      ) {
        this.fileChooser = message.chooser;
        this.options.onFileChooser?.(message.chooser);
      }
      return;
    }
    if (message.type === 'find') {
      if (message.target === this.tab && message.epoch === this.epoch)
        this.options.onFind?.({ query: message.query, found: message.found });
      return;
    }
    if (message.type === 'dialog') {
      if (
        message.target === this.tab &&
        (!message.dialog ||
          this.controlled ||
          (this.editTabs &&
            message.dialog.authority === 'directory' &&
            message.dialog.type === 'beforeunload'))
      ) {
        this.dialogOpen = !!message.dialog;
        this.directoryDialog =
          message.dialog?.authority === 'directory'
            ? message.dialog.id
            : undefined;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          if (!this.dialogOpen)
            pending.timer = setTimeout(pending.expire, 25000);
        }
        this.options.onDialog?.(message.dialog);
      }
      return;
    }
    if (message.type === 'session_access') {
      this.editTabs = message.editTabs;
      this.restoreTabs = message.editTabs && message.restoreTabs !== false;
      if (!this.editTabs && this.directoryDialog) {
        this.directoryDialog = undefined;
        this.dialogOpen = false;
        this.options.onDialog?.(null);
      }
      this.options.onSessionAccess?.(message.editTabs, this.restoreTabs);
      return;
    }
    if (message.type === 'resource') {
      if (message.target === this.tab)
        this.resources?.available(message.resource);
      return;
    }
    if (message.type === 'control') {
      if (message.target === this.tab) {
        this.controlled = message.active;
        if (!message.active) {
          if (!this.directoryDialog) {
            this.dialogOpen = false;
            this.options.onDialog?.(null);
          }
          this.fileChooser = null;
          this.options.onFileChooser?.(null);
          this.queuedWheel = undefined;
          this.inputEngaged = false;
          this.cancelInput();
          this.clearProxy();
        }
        this.options.onControl?.(message.active);
        this.layout();
      }
      return;
    }
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
      this.pages.reconcile(message.state.tabs);
      this.tabURLs = new Map(
        message.state.tabs.map((tab) => [tab.id, tab.url]),
      );
      this.tabTitles = new Map(
        message.state.tabs.map((tab) => [tab.id, tab.title || tab.url]),
      );
      if (message.state.active !== this.tab) {
        this.dialogOpen = false;
        this.directoryDialog = undefined;
        this.options.onDialog?.(null);
        this.fileChooser = null;
        this.options.onFileChooser?.(null);
        this.controlled = false;
        this.options.onControl?.(false);
        for (const [id, pending] of this.pending) {
          if (pending.chrome) continue;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.resolve(false);
        }
        this.prepareFrame();
        this.ready = false;
        this.pageError.hidden = true;
        this.queuedWheel = undefined;
        this.tab = message.state.active;
        this.media.select(this.tab);
        this.epoch = '';
        this.options.onStatus?.(this.connected ? 'refreshing' : 'connecting');
      }
      this.options.onTabs?.(message.state);
      return;
    }
    if (message.type === 'hello') {
      if (
        message.version !== PROTOCOL_VERSION ||
        message.mediaWireVersion !== MEDIA_WIRE_VERSION
      ) {
        // Closing a carrier can be asynchronous. Fence every queued callback
        // now; a later hello cannot revive this incompatible connection.
        this.incompatible = true;
        this.disconnected('version_mismatch');
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
      this.zoom = message.state.zoom;
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
        this.pages.drop(this.tab);
        this.pages.present(this.surface);
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
      this.prepareFrame();
      this.ready = false;
      this.pageError.hidden = true;
      this.queuedWheel = undefined;
      this.epoch = message.epoch;
      this.documentURL = this.tabURLs.get(this.tab) ?? '';
      this.sequence = message.sequence;
      this.resyncing = false;
      this.eventBytes = 0;
      this.sourceFocus = undefined;
      this.surface.style.opacity = '0';
      this.surface.style.visibility = 'hidden';
      this.surface.inert = true;
      this.options.onStatus?.('refreshing');
      const resources = new ReplayResources(
        () => this.options.onNotice?.(this.text('notice.resource_limit')),
        this.options.fetchResource,
      );
      this.resources = resources;
      for (const resource of message.resources) resources.available(resource);
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
          if (!this.previewTarget || this.previewTarget === this.tab) {
            this.pages.present(this.surface);
            this.previewTarget = undefined;
          }
          this.pages.drop(this.tab);
          this.applyFocus();
          this.options.onStatus?.('live');
          for (const changed of this.readiness) changed();
        },
        () => this.options.onNotice?.(this.text('page.stylesSlow')),
        () => resources.pending,
        () => resources.fontsPending,
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
          liveFrameDocuments,
          liveScroll,
          liveSelection,
          svgStyles,
          mathElements,
          {
            onBuild: (node) => {
              if ('getRootNode' in node) {
                resources.build(node as Node);
                presentation.build(node as Node);
              }
            },
          },
        ],
        insertStyleRules: [
          `[${INPUT_PROXY_ATTRIBUTE}]{opacity:0!important}`,
          ':not([data-floebrowser-canvas])[data-floebrowser-unsupported]{display:flex!important;align-items:center;justify-content:center;background:#f3f5f8!important;border:1px dashed #c9d1dd!important;color:#64748b!important;font:12px/1.5 system-ui!important;overflow:hidden}',
          ':not([data-floebrowser-canvas])[data-floebrowser-unsupported]::after{content:attr(data-floebrowser-unsupported);padding:12px;text-align:center}',
          'a,button,select,input[type=checkbox],input[type=radio]{cursor:pointer}',
        ],
      });
      this.replayer.on(ReplayerEvents.FullsnapshotRebuilded, () => {
        presentation.start();
      });
      const rendered = this.replayer;
      this.replayer.on(ReplayerEvents.EventCast, (raw) => {
        if (this.replayer !== rendered) return;
        const event = raw as eventWithTime;
        if (
          event.type === EventType.IncrementalSnapshot &&
          [
            IncrementalSource.StyleSheetRule,
            IncrementalSource.StyleDeclaration,
            IncrementalSource.AdoptedStyleSheet,
          ].includes(event.data.source)
        )
          resources.styles();
        this.inputFonts.event(event, this.replayer?.iframe.contentDocument);
        if (
          event.type === EventType.FullSnapshot ||
          (event.type === EventType.IncrementalSnapshot &&
            event.data.source === IncrementalSource.Mutation)
        ) {
          this.applyFocus();
        } else if (
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Input
        ) {
          this.applyFocus();
        }
      });
      this.replayer.startLive(now);
      for (const event of message.events) this.applyEvent(event, now);
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
      for (const event of message.events) this.applyEvent(event, now);
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
        // Hover and input release have no business effect to repeat. An old document's
        // late failure must not interrupt the page that replaced it.
        if (
          pending.quiet ||
          (pending.documentBound && pending.epoch !== this.epoch)
        )
          return;
        if (message.code === 'navigation_failed' && !this.pageError.hidden)
          return;
        if (message.code === 'stale_view') {
          // A loading or rebuilding view is already fenced and awaiting source
          // state. A rejected old gesture cannot trigger another refresh loop.
          if (!this.ready) return;
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
        this.options.onNotice?.(
          this.text(`action.${message.code ?? 'action_failed'}`),
        );
      }
      return;
    }
    if (message.type === 'notice')
      this.options.onNotice?.(this.text(`notice.${message.code}`));
  }

  private applyEvent(event: eventWithTime, timestamp: number): void {
    const replayer = this.replayer;
    if (!replayer) return;
    if (
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.Font &&
      !event.data.buffer &&
      this.resources
    ) {
      const data = event.data;
      this.resources.font(data.fontSource, (fontSource) => {
        if (this.replayer !== replayer) return;
        for (const next of liveEvents(
          { ...event, data: { ...data, fontSource } },
          timestamp,
        ))
          replayer.addEvent(next);
      });
      return;
    }
    for (const next of liveEvents(event, timestamp)) replayer.addEvent(next);
  }

  private resync(): void {
    if (this.resyncing || !this.connected) return;
    this.resyncing = true;
    this.ready = false;
    this.queuedWheel = undefined;
    this.options.onStatus?.(this.replayer ? 'refreshing' : 'connecting');
    this.connection.send({ type: 'resync' });
  }

  /** Preview remains inert until the source selects and rebuilds this tab. */
  previewTab(target: string): void {
    this.cancelInput();
    this.clearProxy();
    if (target === this.tab && this.ready) {
      this.previewTarget = undefined;
      this.pages.present(this.surface);
    } else {
      this.previewTarget = target;
      this.pages.preview(target);
    }
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
    if (!this.controlled || !this.connected || !this.ready || this.tabCommands)
      return;
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
      (this.previewTarget &&
        this.previewTarget !== this.tab &&
        !action.kind.startsWith('tab_') &&
        action.kind !== 'release_input' &&
        action.kind !== 'dialog_reply') ||
      (action.kind === 'tab_restore' && !this.restoreTabs) ||
      (!this.controlled &&
        !action.kind.startsWith('tab_') &&
        !(
          action.kind === 'dialog_reply' &&
          this.editTabs &&
          action.dialog === this.directoryDialog
        )) ||
      (!this.editTabs &&
        action.kind.startsWith('tab_') &&
        action.kind !== 'tab_select') ||
      (this.tabCommands > 0 &&
        !action.kind.startsWith('tab_') &&
        action.kind !== 'dialog_reply') ||
      (!this.ready &&
        ![
          'release_input',
          'navigate',
          'back',
          'forward',
          'reload',
          'stop',
          'dialog_reply',
          'file_reply',
          'download_cancel',
          'viewport',
          'zoom',
          'tab_new',
          'tab_restore',
          'tab_pin',
          'tab_select',
          'tab_close',
          'tab_move',
        ].includes(action.kind))
    )
      return Promise.resolve(false);
    if (action.kind === 'text' && action.text.length > 16000) {
      this.options.onNotice?.(this.text('action.pasteLimit'));
      return Promise.resolve(false);
    }
    const chrome = action.kind.startsWith('tab_');
    if (
      [...this.pending.values()].filter((pending) => pending.chrome === chrome)
        .length >= MAX_PENDING_COMMANDS
    ) {
      this.options.onNotice?.(this.text('action.busy'));
      return Promise.resolve(false);
    }
    const id = ++this.nextID;
    const tab = this.tab;
    const epoch = this.epoch;
    const quiet =
      action.kind === 'release_input' ||
      (action.kind === 'pointer' &&
        action.phase === 'move' &&
        action.buttons === 0);
    const documentBound = [
      'release_input',
      'pointer',
      'wheel',
      'key',
      'text',
      'select',
      'media',
      'find',
    ].includes(action.kind);
    return new Promise((resolve) => {
      const expire = () => {
        this.pending.delete(id);
        resolve(false);
        if (
          !quiet &&
          (!documentBound || epoch === this.epoch) &&
          (chrome || this.tab === tab)
        )
          this.options.onNotice?.(this.text('action.timeout'));
      };
      const timer = setTimeout(expire, 25000);
      if (this.dialogOpen && action.kind !== 'dialog_reply')
        clearTimeout(timer);
      this.pending.set(id, {
        resolve,
        timer,
        expire,
        started: performance.now(),
        epoch: this.epoch,
        tab: this.tab,
        chrome,
        documentBound,
        quiet,
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

  get canUpload(): boolean {
    return !!this.connection.upload;
  }
  get canDownload(): boolean {
    return !!this.connection.download;
  }
  download(target: string, id: string, signal: AbortSignal): Promise<void> {
    if (
      !this.connected ||
      !this.tabTitles.has(target) ||
      !this.connection.download
    )
      return Promise.reject(new Error('Download unavailable'));
    return this.connection.download(target, id, signal);
  }
  upload(
    request: FileChooserState,
    file: File,
    signal: AbortSignal,
  ): Promise<string> {
    if (
      !this.connected ||
      !this.controlled ||
      request.target !== this.tab ||
      this.fileChooser?.id !== request.id ||
      !this.connection.upload
    )
      return Promise.reject(new Error('File chooser unavailable'));
    return this.connection.upload(request, file, signal);
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
      !this.controlled ||
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
        !this.controlled ||
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
      !this.controlled ||
      width < 1 ||
      height < 1 ||
      this.tabCommands ||
      (Math.round(width / this.zoom) === this.viewport.width &&
        Math.round(height / this.zoom) === this.viewport.height)
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
    const mode =
      !this.controlled && this.viewportMode === 'responsive'
        ? 'fit'
        : this.viewportMode;
    this.container.dataset.viewportMode = mode;
    // State confirms source sizing before rrweb's sampled resize event arrives.
    // Keep the replay viewport and its coordinate transform in the same layout.
    if (this.replayer) {
      this.replayer.iframe.width = String(this.viewport.width);
      this.replayer.iframe.height = String(this.viewport.height);
    }
    const scale =
      mode !== 'actual'
        ? Math.min(
            this.zoom,
            this.container.clientWidth / this.viewport.width,
            this.container.clientHeight / this.viewport.height,
          )
        : this.zoom;
    this.surface.style.width = `${this.viewport.width}px`;
    this.surface.style.height = `${this.viewport.height}px`;
    this.surface.style.transform = `scale(${scale})`;
    this.surface.style.left =
      mode === 'responsive'
        ? '0px'
        : `${Math.max(0, (this.container.clientWidth - this.viewport.width * scale) / 2)}px`;
    this.surface.style.top =
      mode === 'fit'
        ? `${Math.max(0, (this.container.clientHeight - this.viewport.height * scale) / 2)}px`
        : '0px';
    this.scheduleViewport();
  }

  private hit(event: MouseEvent) {
    return this.replayer && this.ready
      ? replayHit(this.replayer.iframe, event.clientX, event.clientY)
      : undefined;
  }

  private point(hit: NonNullable<ReturnType<typeof replayHit>>) {
    const node = this.replayer!.getMirror().getId(hit.target);
    const rect = hit.target.getBoundingClientRect();
    if (node < 1 || !rect.width || !rect.height) return;
    return {
      node,
      x: Math.max(0, Math.min(1, (hit.x - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (hit.y - rect.top) / rect.height)),
    };
  }

  private installInput(): void {
    this.replayer!.enableInteract();
    this.replayer!.iframe.setAttribute('scrolling', 'no');
    this.replayer!.iframe.setAttribute('tabindex', '-1');
    // WebKit suppresses listeners even when installed by the host into an inert
    // document. All engines use this trusted surface; the iframe stays scriptless.
    this.replayer!.iframe.style.pointerEvents = 'none';
  }

  private cancelInput(): void {
    this.compositionAuthority = undefined;
    this.composing = false;
    if (this.heldInput) void this.dispatch({ kind: 'release_input' });
    this.heldInput = false;
    this.dragging = false;
  }

  private bindInput(): void {
    for (const target of [this.inputSurface, this.sink]) {
      this.bindTextInput(target);
      this.listen(target, 'keydown', (event) =>
        this.key(event as KeyboardEvent, 'down'),
      );
      this.listen(target, 'keyup', (event) =>
        this.key(event as KeyboardEvent, 'up'),
      );
    }
    this.listen(this.inputSurface, 'mousedown', (raw) => {
      this.media.interact(raw);
      const event = raw as MouseEvent;
      if (!this.controlled || !this.ready) {
        event.preventDefault();
        return;
      }
      const hit = this.hit(event);
      if (!hit) {
        event.preventDefault();
        return;
      }
      this.inputEngaged = true;
      const select = hit.target.closest('select');
      if (select) {
        const proxy = this.proxyFor(select) as HTMLSelectElement;
        if (event.target !== proxy) {
          event.preventDefault();
          proxy.focus({ preventScroll: true });
          if (typeof proxy.showPicker === 'function') proxy.showPicker();
        }
        return;
      }
      event.preventDefault();
      const point = this.point(hit);
      if (!point) return;
      this.sourceFocus = undefined;
      this.clearProxy();
      this.sink.focus({ preventScroll: true });
      this.dragging = this.heldInput = true;
      void this.dispatch({
        kind: 'pointer',
        phase: 'down',
        point,
        button: mouseButton(event.button),
        buttons: event.buttons,
        modifiers: modifiers(event),
        clicks: Math.max(1, Math.min(3, event.detail || 1)),
      });
    });
    this.listen(window, 'mouseup', (raw) => {
      if (!this.dragging) return;
      const event = raw as MouseEvent;
      const hit = this.hit(event),
        point = hit && this.point(hit);
      if (!point) {
        this.cancelInput();
        return;
      }
      this.dragging = false;
      void this.dispatch({
        kind: 'pointer',
        phase: 'up',
        point,
        button: mouseButton(event.button),
        buttons: event.buttons,
        modifiers: modifiers(event),
        clicks: Math.max(1, Math.min(3, event.detail || 1)),
      });
    });
    this.listen(window, 'mousemove', (raw) => {
      const event = raw as MouseEvent;
      if (
        !this.controlled ||
        (!this.dragging && !this.inputSurface.contains(event.target as Node))
      )
        return;
      const hit = this.hit(event);
      if (!hit) return;
      if (!this.dragging) {
        const cursor = hit.target.ownerDocument.defaultView!.getComputedStyle(
          hit.target,
        ).cursor;
        this.inputSurface.style.cursor = /^[a-z-]+$/.test(cursor)
          ? cursor
          : 'auto';
        const select = hit.target.closest('select');
        if (select) this.proxyFor(select);
        else if (this.inputProxy?.control.tagName === 'SELECT')
          this.clearProxy();
      }
      if (!this.dragging && performance.now() - this.lastMove < 40) return;
      this.lastMove = performance.now();
      const point = this.point(hit);
      if (point)
        void this.dispatch({
          kind: 'pointer',
          phase: 'move',
          point,
          button: 'left',
          buttons: this.dragging ? event.buttons : 0,
          modifiers: modifiers(event),
          clicks: 1,
        });
    });
    this.listen(this.inputSurface, 'contextmenu', (event) =>
      event.preventDefault(),
    );
    this.listen(
      this.inputSurface,
      'wheel',
      (raw) => {
        raw.preventDefault();
        if (!this.controlled) return;
        const event = raw as WheelEvent;
        const hit = this.hit(event);
        if (!hit) return;
        const mapped = mapWheelPoint(hit.target, {
          space: 'client',
          x: hit.x,
          y: hit.y,
          dx: event.deltaX,
          dy: event.deltaY,
        });
        if (!mapped?.node) return;
        const node = this.replayer!.getMirror().getId(mapped.node);
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
      { passive: false },
    );
  }

  private key(event: KeyboardEvent, phase: 'down' | 'up'): void {
    if (phase === 'down') this.media.interact(event);
    if (this.composing || event.isComposing || event.key === 'Process') return;
    if (this.options.onShortcut?.(event, phase)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
      ['c', 'v'].includes(event.key.toLowerCase())
    )
      return;
    // Native select UI belongs to the host. Its change is sent through the same
    // epoch-fenced source action as pointer-based selection.
    if ((event.target as Element).tagName === 'SELECT') return;
    this.heldInput = true;
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
    this.resources?.dispose();
    this.fileChooser = null;
    this.options.onFileChooser?.(null);
    this.dialogOpen = false;
    this.directoryDialog = undefined;
    this.options.onDialog?.(null);
    clearTimeout(this.viewportTimer);
    this.queuedWheel = undefined;
    this.media.reset();
    this.disconnectReason = reason ?? this.disconnectReason;
    this.connected = false;
    this.controlled = false;
    this.options.onControl?.(false);
    this.ready = false;
    this.dragging = false;
    this.presentation?.dispose();
    this.pages.clear();
    this.previewTarget = undefined;
    this.options.onStatus?.('disconnected', this.disconnectReason);
    for (const changed of this.readiness) changed();
    if (this.pending.size)
      this.options.onNotice?.(this.text('connection.unconfirmed'));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pending.clear();
  }
  private prepareFrame(): void {
    const replayer = this.replayer,
      resources = this.resources;
    if (
      this.pages.enabled &&
      this.ready &&
      replayer &&
      resources &&
      this.tab &&
      this.documentURL === this.tabURLs.get(this.tab)
    ) {
      replayer.pause();
      this.pages.retain(
        this.tab,
        this.documentURL,
        this.tabTitles.get(this.tab) ?? this.documentURL,
        this.surface,
        () => {
          resources.dispose();
          replayer.destroy();
        },
      );
      this.resources = undefined;
    } else {
      replayer?.destroy();
      this.surface.remove();
    }
    this.replayer = undefined;
    this.presentation?.dispose();
    this.clearFrame();
    this.surface = this.pages.create();
  }

  private clearFrame(): void {
    this.resources?.dispose();
    this.resources = undefined;
    cancelAnimationFrame(this.focusFrame);
    this.focusFrame = 0;
    this.cancelInput();
    this.clearProxy();
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
    this.pages.destroy();
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
  let uploadToken = '';
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
        if (
          typeof parsed.uploadToken !== 'string' ||
          !/^[\w-]{43}$/.test(parsed.uploadToken)
        )
          throw new Error('Invalid upload carrier');
        uploadToken = parsed.uploadToken;
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
            }
            consumed += data.byteLength;
            const ack = new Uint8Array(8);
            new DataView(ack.buffer).setBigUint64(0, BigInt(consumed));
            media!.send(ack);
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
    download: async (target, id, signal) => {
      signal.throwIfAborted();
      if (socket.readyState !== WebSocket.OPEN || !uploadToken)
        throw new Error('Disconnected');
      const address = new URL(url, location.href);
      address.protocol = address.protocol === 'wss:' ? 'https:' : 'http:';
      address.pathname = address.pathname.replace(
        /stream$/,
        `download/${uploadToken}/${encodeURIComponent(target)}/${encodeURIComponent(id)}`,
      );
      address.search = '';
      const anchor = document.createElement('a');
      anchor.href = address.href;
      anchor.download = '';
      anchor.referrerPolicy = 'no-referrer';
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
    upload: async (request, file, signal) => {
      if (socket.readyState !== WebSocket.OPEN || !uploadToken)
        throw new Error('Disconnected');
      const address = new URL(url, location.href);
      address.protocol = address.protocol === 'wss:' ? 'https:' : 'http:';
      address.pathname = address.pathname.replace(
        /stream$/,
        `upload/${uploadToken}/${request.id}`,
      );
      address.search = '';
      const response = await fetch(address, {
        method: 'POST',
        body: file,
        signal,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Floe-File': encodeURIComponent(
            JSON.stringify({
              name: file.name,
              size: file.size,
              ...(file.webkitRelativePath
                ? { relativePath: file.webkitRelativePath }
                : {}),
            }),
          ),
        },
      });
      if (!response.ok) throw new Error('File transfer rejected');
      const { id } = await response.json();
      if (typeof id !== 'string' || !/^[\w-]{32}$/.test(id))
        throw new Error('Invalid upload identity');
      return id;
    },
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
