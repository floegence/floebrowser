import { EventEmitter } from 'node:events';
import type {
  SourceElement,
  SourceFrame,
  SourceFunction,
  SourcePage,
  SourceTransport,
  SourceViewport,
} from './source.js';

export type SourceContext = {
  id: number;
  auxData?: { isDefault?: boolean; frameId?: string };
};
export interface CDPSourceOptions {
  id: string;
  transport: SourceTransport;
  /** Existing default contexts when borrowing an already enabled connection.
   * Register this adapter before Runtime.enable, or supply the owner's cache. */
  contexts?: readonly SourceContext[];
  viewport?: SourceViewport;
  setViewport?: (size: SourceViewport) => Promise<void>;
  activate?: () => Promise<void>;
  close?: () => Promise<void>;
  createPage?: () => Promise<SourcePage>;
}

/** Adapts a host-owned debugger without attaching another session, changing
 * auto-attach, disabling domains or disconnecting the owner's transport. */
export class CDPSourcePage extends EventEmitter implements SourcePage {
  readonly id: string;
  readonly transport: SourceTransport;
  private frameMap = new Map<string, CDPFrame>();
  private sessionMap = new Map<
    SourceTransport,
    { dispose: () => void; ready: Promise<void> }
  >();
  private mainID = '';
  private size: SourceViewport | null;
  private closed = false;
  private navigations = new Set<() => void>();
  private disposed = false;
  private constructor(private options: CDPSourceOptions) {
    super();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.id))
      throw new Error('Invalid source target identity');
    this.id = options.id;
    this.transport = options.transport;
    this.size = options.viewport ?? null;
  }
  static async attach(options: CDPSourceOptions): Promise<CDPSourcePage> {
    const page = new CDPSourcePage(options);
    try {
      await page.addSession(options.transport, options.contexts);
      return page;
    } catch (error) {
      page.dispose();
      throw error;
    }
  }
  /** Called by the SAME owner that handles debugger child attachment. */
  addSession(
    transport: SourceTransport,
    contexts: readonly SourceContext[] = [],
  ): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error('Source adapter disposed'));
    const existing = this.sessionMap.get(transport);
    if (existing) return existing.ready;
    const disposers: Array<() => void> = [];
    const listen = (event: string, handler: (...args: any[]) => void) => {
      transport.on(event, handler);
      disposers.push(() => transport.off(event, handler));
    };
    const active = () => !this.disposed && this.sessionMap.has(transport);
    const context = (value: SourceContext) => {
      if (!value.auxData?.isDefault || !value.auxData.frameId || !active())
        return;
      const frame = this.frame(value.auxData.frameId, transport);
      frame.transport = transport;
      frame.contextID = value.id;
    };
    const navigate = (frame: any) => {
      if (!active()) return;
      const current = this.frame(frame.id, transport);
      current.transport = transport;
      current.address = frame.url;
      current.loaderID = frame.loaderId ?? current.loaderID;
      if (frame.parentId) current.parentID = frame.parentId;
      if (transport === this.transport && !frame.parentId)
        this.mainID = frame.id;
      this.emit('framenavigated', current);
    };
    listen('Runtime.executionContextCreated', ({ context: value }) =>
      context(value),
    );
    listen('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      for (const frame of this.frameMap.values())
        if (
          frame.transport === transport &&
          frame.contextID === executionContextId
        )
          frame.contextID = 0;
    });
    listen('Runtime.executionContextsCleared', () => {
      for (const frame of this.frameMap.values())
        if (frame.transport === transport) frame.contextID = 0;
    });
    listen('Page.frameNavigated', ({ frame }) => navigate(frame));
    listen('Page.navigatedWithinDocument', ({ frameId, url }) => {
      const frame = this.frameMap.get(frameId);
      if (frame) {
        frame.address = url;
        this.emit('framenavigated', frame);
      }
    });
    listen('Page.frameAttached', ({ frameId, parentFrameId }) => {
      const frame = this.frame(frameId, transport);
      frame.parentID = parentFrameId;
      this.emit('frameattached', frame);
    });
    listen('Page.frameDetached', ({ frameId, reason }) => {
      // A process swap changes the transport, not the host page/frame identity.
      if (reason !== 'swap') this.removeFrame(frameId);
    });
    listen('close', () => {
      this.removeSession(transport);
      if (transport === this.transport) this.markClosed();
    });
    if (transport === this.transport) {
      listen('Page.domContentEventFired', () => this.emit('domcontentloaded'));
      listen('Page.loadEventFired', () => this.emit('load'));
      listen('Inspector.targetCrashed', () => this.emit('crash'));
      listen('Page.javascriptDialogOpening', (dialog) =>
        this.emit('dialog', {
          ...dialog,
          dismiss: () =>
            transport.send('Page.handleJavaScriptDialog', { accept: false }),
          accept: (promptText?: string) =>
            transport.send('Page.handleJavaScriptDialog', {
              accept: true,
              promptText,
            }),
        }),
      );
      listen('Page.downloadWillBegin', (download) =>
        this.emit('download', download),
      );
    }
    const entry = {
      dispose: () => {
        for (const dispose of disposers) dispose();
      },
      ready: Promise.resolve(),
    };
    this.sessionMap.set(transport, entry);
    entry.ready = (async () => {
      await transport.send('Page.enable');
      await transport.send('Page.setLifecycleEventsEnabled', { enabled: true });
      const { frameTree } = await transport.send('Page.getFrameTree');
      const visit = (tree: any) => {
        navigate(tree.frame);
        for (const child of tree.childFrames ?? []) visit(child);
      };
      visit(frameTree);
      for (const value of contexts) context(value);
      await transport.send('Runtime.enable');
      if (!active()) return;
      this.emit('sessionattached', transport);
    })().catch((error) => {
      this.removeSession(transport);
      throw error;
    });
    return entry.ready;
  }
  removeSession(transport: SourceTransport): void {
    const entry = this.sessionMap.get(transport);
    if (!entry) return;
    this.sessionMap.delete(transport);
    entry.dispose();
    for (const frame of this.frameMap.values())
      if (frame.transport === transport) frame.contextID = 0;
    this.emit('sessiondetached', transport);
  }
  private frame(id: string, transport: SourceTransport): CDPFrame {
    let frame = this.frameMap.get(id);
    if (!frame) {
      frame = new CDPFrame(this, id, transport);
      this.frameMap.set(id, frame);
    }
    return frame;
  }
  getFrame(id: string): CDPFrame | undefined {
    return this.frameMap.get(id);
  }
  private removeFrame(id: string): void {
    const frame = this.frameMap.get(id);
    if (!frame) return;
    for (const child of [...this.frameMap.values()])
      if (child.parentID === id) this.removeFrame(child.id);
    this.frameMap.delete(id);
    frame.contextID = 0;
    this.emit('framedetached', frame);
  }
  frames(): SourceFrame[] {
    return [...this.frameMap.values()];
  }
  sessions(): SourceTransport[] {
    return [...this.sessionMap.keys()];
  }
  mainFrame(): SourceFrame {
    const frame = this.frameMap.get(this.mainID);
    if (!frame) throw new Error('Source document unavailable');
    return frame;
  }
  url(): string {
    return this.frameMap.get(this.mainID)?.address ?? 'about:blank';
  }
  title(): Promise<string> {
    return this.mainFrame().evaluate(() => document.title);
  }
  viewportSize(): SourceViewport | null {
    return this.size && { ...this.size };
  }
  async setViewportSize(size: SourceViewport): Promise<void> {
    if (this.options.setViewport) await this.options.setViewport(size);
    else
      await this.transport.send('Emulation.setDeviceMetricsOverride', {
        ...size,
        deviceScaleFactor: 1,
        mobile: false,
      });
    this.size = { ...size };
  }
  navigate(url: string): Promise<void> {
    return this.navigation('Page.navigate', { url });
  }
  async traverse(direction: -1 | 1): Promise<void> {
    const { entries, currentIndex } = await this.transport.send(
      'Page.getNavigationHistory',
    );
    const entry = entries[currentIndex + direction];
    if (entry)
      await this.navigation('Page.navigateToHistoryEntry', {
        entryId: entry.id,
      });
  }
  reload(): Promise<void> {
    return this.navigation('Page.reload');
  }
  async stop(): Promise<void> {
    // Cancellation is control traffic: it must reach Chromium while navigate()
    // is still waiting for a response or a document commit.
    for (const cancel of this.navigations) cancel();
    await this.transport.send('Page.stopLoading');
  }
  private async navigation(method: string, parameters?: any): Promise<void> {
    let ready!: () => void, cancel!: () => void;
    const loaded = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    this.navigations.add(cancel);
    const initialLoader = this.frameMap.get(this.mainID)?.loaderID;
    let targetLoader: string | undefined;
    const loadedIDs = new Set<string>();
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReady = () => {
      clearTimeout(settleTimer);
      // A document can synchronously replace itself from an inline script. Do
      // not expose the first intermediate snapshot as a completed navigation.
      settleTimer = setTimeout(() => ready(), 25);
    };
    const lifecycle = ({
      frameId,
      loaderId,
      name,
    }: {
      frameId: string;
      loaderId: string;
      name: string;
    }) => {
      if (frameId !== this.mainID || name !== 'DOMContentLoaded') return;
      loadedIDs.add(loaderId);
      if (loaderId === targetLoader) scheduleReady();
    };
    const committed = ({
      frame,
    }: {
      frame: { id: string; loaderId: string };
    }) => {
      if (frame.id !== this.mainID || frame.loaderId === initialLoader) return;
      // Redirects and client-side replacements can commit a newer loader after
      // Page.navigate has already returned. Follow the last committed loader
      // for every navigation method.
      targetLoader = frame.loaderId;
      clearTimeout(settleTimer);
      if (loadedIDs.has(targetLoader)) scheduleReady();
    };
    this.transport.on('Page.lifecycleEvent', lifecycle);
    this.transport.on('Page.frameNavigated', committed);
    const withinDocument = ({ frameId }: { frameId: string }) => {
      // History traversal can select a hash entry without creating a loader.
      // Page.navigate reports the same-document case explicitly, while
      // Page.navigateToHistoryEntry only emits this event.
      if (method !== 'Page.navigate' && frameId === this.mainID) ready();
    };
    this.transport.on('Page.navigatedWithinDocument', withinDocument);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        const result = await this.transport.send(method, parameters);
        if (result.isDownload) return;
        if (result.errorText) throw new Error('Source navigation failed');
        if (method === 'Page.navigate') {
          if (!result.loaderId) return; // Chromium confirmed a same-document navigation.
          targetLoader = result.loaderId;
          if (loadedIDs.has(result.loaderId)) scheduleReady();
        }
        await loaded;
      })();
      await Promise.race([
        work,
        cancelled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Source navigation timed out')),
            20000,
          );
        }),
      ]);
    } finally {
      this.navigations.delete(cancel);
      clearTimeout(timer);
      clearTimeout(settleTimer);
      this.transport.off('Page.lifecycleEvent', lifecycle);
      this.transport.off('Page.frameNavigated', committed);
      this.transport.off('Page.navigatedWithinDocument', withinDocument);
    }
  }
  bringToFront(): Promise<void> {
    return (
      this.options.activate?.() ?? this.transport.send('Page.bringToFront')
    );
  }
  isClosed(): boolean {
    return this.closed;
  }
  async close(): Promise<void> {
    if (!this.options.close)
      throw new Error('The source host does not allow closing this page');
    await this.options.close();
  }
  createPage(): Promise<SourcePage> {
    if (!this.options.createPage)
      return Promise.reject(
        new Error('The source host does not allow creating pages'),
      );
    return this.options.createPage();
  }
  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    this.dispose();
  }
  /** Releases only this adapter's listeners. Source pages and debugger sessions
   * remain owned by the host and usable by its other authorized consumers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
    for (const transport of this.sessions()) this.removeSession(transport);
    this.removeAllListeners();
  }
}

class CDPFrame implements SourceFrame {
  contextID = 0;
  address = 'about:blank';
  loaderID = '';
  parentID = '';
  constructor(
    private page: CDPSourcePage,
    readonly id: string,
    public transport: SourceTransport,
  ) {}
  url(): string {
    return this.address;
  }
  isDetached(): boolean {
    return this.page.isClosed() || this.page.getFrame(this.id) !== this;
  }
  parentFrame(): SourceFrame | null {
    return this.page.getFrame(this.parentID) ?? null;
  }
  private async call<A>(
    fn: string | SourceFunction<A, unknown>,
    argument?: A,
    byValue = true,
  ): Promise<any> {
    if (!this.contextID || this.isDetached())
      throw new Error('Source frame context unavailable');
    const result =
      typeof fn === 'string'
        ? await this.transport.send('Runtime.evaluate', {
            expression: fn,
            contextId: this.contextID,
            returnByValue: byValue,
            awaitPromise: true,
          })
        : await this.transport.send('Runtime.callFunctionOn', {
            functionDeclaration: String(fn),
            arguments: [{ value: argument }],
            executionContextId: this.contextID,
            returnByValue: byValue,
            awaitPromise: true,
          });
    if (result.exceptionDetails)
      throw new Error('Source frame evaluation failed');
    return result.result;
  }
  async evaluate<A, R>(
    fn: string | SourceFunction<A, R>,
    argument?: A,
  ): Promise<R> {
    return (await this.call(fn, argument)).value;
  }
  async frameElement(): Promise<SourceElement> {
    const parent = this.parentFrame();
    if (!parent || !parent.contextID)
      throw new Error('Source frame owner unavailable');
    const { backendNodeId } = await parent.transport.send('DOM.getFrameOwner', {
      frameId: this.id,
    });
    const { object } = await parent.transport.send('DOM.resolveNode', {
      backendNodeId,
      executionContextId: parent.contextID,
    });
    if (!object.objectId) throw new Error('Source frame owner unavailable');
    return new CDPElement(parent, object.objectId, this.page);
  }
  async resolve(
    key: string,
    id: number,
  ): Promise<{ element?: SourceElement; frame?: SourceFrame; id?: number }> {
    const result = await this.call(
      ({ key, id }) => (window as any)[key]?.resolve(id) ?? {},
      { key, id },
      false,
    );
    if (!result.objectId) return {};
    const objects = new Set<string>([result.objectId]);
    try {
      const { result: properties } = await this.transport.send(
        'Runtime.getProperties',
        { objectId: result.objectId, ownProperties: true },
      );
      const values = new Map<string, any>();
      for (const property of properties) {
        values.set(property.name, property.value);
        if (property.value?.objectId) objects.add(property.value.objectId);
      }
      const node = values.get('node');
      if (node?.subtype === 'node' && node.objectId) {
        objects.delete(node.objectId);
        return { element: new CDPElement(this, node.objectId, this.page) };
      }
      const child = values.get('frame');
      if (child?.subtype === 'node' && child.objectId) {
        const { node: owner } = await this.transport.send('DOM.describeNode', {
          objectId: child.objectId,
        });
        const remoteID = values.get('id')?.value;
        if (typeof remoteID === 'number')
          return { frame: this.page.getFrame(owner.frameId), id: remoteID };
      }
      return {};
    } finally {
      await Promise.all(
        [...objects].map((objectId) =>
          this.transport
            .send('Runtime.releaseObject', { objectId })
            .catch(() => {}),
        ),
      );
    }
  }
}
class CDPElement implements SourceElement {
  private disposed = false;
  private transport: SourceTransport;
  private context: number;
  constructor(
    private frame: SourceFrame,
    private objectId: string,
    private page: CDPSourcePage,
  ) {
    this.transport = frame.transport;
    this.context = frame.contextID;
  }
  async ownerFrame(): Promise<SourceFrame | null> {
    const { result, exceptionDetails } = await this.transport.send(
      'Runtime.callFunctionOn',
      {
        objectId: this.objectId,
        functionDeclaration:
          'function() { return this.ownerDocument.documentElement; }',
      },
    );
    if (exceptionDetails || !result.objectId)
      throw new Error('Source element document unavailable');
    try {
      const { node } = await this.transport.send('DOM.describeNode', {
        objectId: result.objectId,
      });
      const owner = this.page.getFrame(node.frameId);
      if (!owner) throw new Error('Source element frame unavailable');
      return owner;
    } finally {
      await this.transport
        .send('Runtime.releaseObject', { objectId: result.objectId })
        .catch(() => {});
    }
  }
  async evaluate<A, R>(
    fn: (node: Element, argument: A) => R | Promise<R>,
    argument: A,
    options: { userGesture?: boolean } = {},
  ): Promise<R> {
    if (
      this.disposed ||
      this.frame.isDetached() ||
      this.frame.contextID !== this.context ||
      this.frame.transport !== this.transport
    )
      throw new Error('Source element retired');
    const result = await this.transport.send('Runtime.callFunctionOn', {
      objectId: this.objectId,
      functionDeclaration: `function(argument) { return (${String(fn)})(this, argument); }`,
      arguments: [{ value: argument }],
      returnByValue: true,
      awaitPromise: true,
      userGesture: options.userGesture === true,
    });
    if (result.exceptionDetails)
      throw new Error('Source element evaluation failed');
    return result.result.value;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.transport
      .send('Runtime.releaseObject', { objectId: this.objectId })
      .catch(() => {});
  }
}
