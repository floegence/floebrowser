import type {
  SourceElement,
  SourceFrame,
  SourcePage,
  SourceTransport,
} from './source.js';
import type { ResourceStore } from './resources.js';

/** Installs recorder namespaces on sessions supplied by the source owner. This
 * bridge never attaches/detaches a debugger or changes child auto-attachment. */
export class FrameBridge {
  private sessions = new Map<SourceTransport, string>();
  private pending = new Map<SourceTransport, Promise<void>>();
  private closed = false;
  constructor(
    private page: SourcePage,
    private script: string,
    private key: string,
    private resources: ResourceStore,
  ) {}
  private attached = (transport: SourceTransport) => {
    void this.install(transport);
  };
  private detached = (transport: SourceTransport) => {
    this.sessions.delete(transport);
    this.resources.stop(transport);
  };
  private navigated = (frame: SourceFrame) => {
    if (!this.closed && frame !== this.page.mainFrame())
      void frame.evaluate(this.script).catch(() => {});
  };
  async start(): Promise<void> {
    this.page.on('sessionattached', this.attached);
    this.page.on('sessiondetached', this.detached);
    this.page.on('framenavigated', this.navigated);
    await Promise.all(
      this.page.sessions().map((transport) => this.install(transport)),
    );
    for (const frame of this.page.frames()) this.navigated(frame);
  }
  private install(transport: SourceTransport): Promise<void> {
    if (
      this.closed ||
      transport === this.page.transport ||
      this.sessions.has(transport)
    )
      return Promise.resolve();
    const prior = this.pending.get(transport);
    if (prior) return prior;
    const task = (async () => {
      await this.resources.start(transport);
      const { identifier } = await transport.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: this.script },
      );
      if (this.closed || !this.page.sessions().includes(transport)) {
        await transport
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
          .catch(() => {});
        return;
      }
      this.sessions.set(transport, identifier);
      await Promise.all(
        this.page
          .frames()
          .filter((frame) => frame.transport === transport)
          .map((frame) => frame.evaluate(this.script).catch(() => {})),
      );
    })()
      .catch(() => {})
      .finally(() => this.pending.delete(transport));
    this.pending.set(transport, task);
    return task;
  }
  async snapshot(): Promise<void> {
    await Promise.all(this.pending.values());
    for (const frame of this.page.frames())
      if (frame !== this.page.mainFrame())
        await frame
          .evaluate((key) => (window as any)[key]?.snapshot(), this.key)
          .catch(() => {});
  }
  async resolve(
    id: number,
    frame = this.page.mainFrame(),
    depth = 0,
  ): Promise<SourceElement | undefined> {
    if (this.closed || depth > 32 || frame.isDetached()) return;
    const result = await frame.resolve(this.key, id);
    if (result.element) return result.element;
    if (result.frame && typeof result.id === 'number')
      return this.resolve(result.id, result.frame, depth + 1);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.page.off('sessionattached', this.attached);
    this.page.off('sessiondetached', this.detached);
    this.page.off('framenavigated', this.navigated);
    await Promise.all(this.pending.values());
    for (const frame of this.page.frames())
      if (frame !== this.page.mainFrame())
        await frame
          .evaluate((key) => (window as any)[key]?.stop(), this.key)
          .catch(() => {});
    for (const [transport, identifier] of this.sessions)
      await transport
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
        .catch(() => {});
    this.sessions.clear();
  }
}
