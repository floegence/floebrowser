import type { CDPSession, ElementHandle, Frame, Page } from 'playwright';
import type { ResourceStore } from './resources.js';

/** rrweb merges frame DOM; this bridge injects recorders into Chromium OOPIFs. */
export class FrameBridge {
  private sessions = new Map<Frame, { cdp: CDPSession; script: string }>();
  private pending = new Map<Frame, Promise<void>>();
  private closed = false;
  constructor(
    private page: Page,
    private script: string,
    private key: string,
    private resources: ResourceStore,
  ) {}
  private attached = (frame: Frame) => {
    void this.install(frame);
  };
  private detached = (frame: Frame) => {
    const session = this.sessions.get(frame);
    this.sessions.delete(frame);
    void session?.cdp.detach().catch(() => {});
  };
  async start(): Promise<void> {
    this.page.on('frameattached', this.attached);
    this.page.on('framenavigated', this.attached);
    this.page.on('framedetached', this.detached);
    for (const frame of this.page.frames()) await this.install(frame);
  }
  private install(frame: Frame): Promise<void> {
    if (this.closed || frame === this.page.mainFrame() || frame.isDetached())
      return Promise.resolve();
    const prior = this.pending.get(frame);
    if (prior) return prior;
    const task = (async () => {
      if (!this.sessions.has(frame)) {
        // Same-process frames use the page's CDP session and initialization script.
        const cdp = await this.page
          .context()
          .newCDPSession(frame)
          .catch(() => undefined);
        if (cdp) {
          try {
            await this.resources.start(cdp);
            const { identifier } = await cdp.send(
              'Page.addScriptToEvaluateOnNewDocument',
              { source: this.script },
            );
            if (this.closed || frame.isDetached()) {
              await cdp.detach();
              return;
            }
            this.sessions.set(frame, { cdp, script: identifier });
            cdp.on('close', () => {
              if (this.sessions.get(frame)?.cdp === cdp)
                this.sessions.delete(frame);
            });
          } catch {
            await cdp.detach().catch(() => {});
          }
        }
      }
      if (!this.closed) await frame.evaluate(this.script).catch(() => {});
    })().finally(() => {
      this.pending.delete(frame);
    });
    this.pending.set(frame, task);
    return task;
  }
  async snapshot(): Promise<void> {
    await Promise.all(this.pending.values());
    for (const frame of this.page.frames()) {
      if (frame !== this.page.mainFrame())
        await frame
          .evaluate((key) => (window as any)[key]?.snapshot(), this.key)
          .catch(() => {});
    }
  }
  async resolve(
    id: number,
    frame = this.page.mainFrame(),
    depth = 0,
  ): Promise<ElementHandle<Element> | undefined> {
    if (this.closed || depth > 32 || frame.isDetached()) return;
    const handle = await frame.evaluateHandle(
      ({ key, id }) => (window as any)[key]?.resolve(id) ?? {},
      { key: this.key, id },
    );
    const node = await handle.getProperty('node');
    const element = node.asElement() as ElementHandle<Element> | null;
    if (element) {
      await handle.dispose();
      return element;
    }
    await node.dispose();
    const child = await handle.getProperty('frame');
    const remote = await handle.getProperty('id');
    try {
      const childFrame = await child.asElement()?.contentFrame();
      const remoteID = await remote.jsonValue();
      if (childFrame && typeof remoteID === 'number')
        return await this.resolve(remoteID, childFrame, depth + 1);
    } finally {
      await Promise.all([handle.dispose(), child.dispose(), remote.dispose()]);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.page.off('frameattached', this.attached);
    this.page.off('framenavigated', this.attached);
    this.page.off('framedetached', this.detached);
    await Promise.all(this.pending.values());
    for (const frame of this.page.frames()) {
      if (frame !== this.page.mainFrame())
        await frame
          .evaluate((key) => (window as any)[key]?.stop(), this.key)
          .catch(() => {});
    }
    for (const { cdp, script } of this.sessions.values()) {
      await cdp
        .send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: script,
        })
        .catch(() => {});
      await cdp.detach().catch(() => {});
    }
    this.sessions.clear();
  }
}
