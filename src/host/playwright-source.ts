import type { CDPSession, Frame, Page } from 'playwright';
import { CDPSourcePage } from './cdp-source.js';

const sources = new WeakMap<Page, Promise<CDPSourcePage>>();

/** Optional Playwright lifecycle owner. Consumers share each returned source
 * and its debugger with AI tools; projections never attach a second debugger. */
export class PlaywrightSourceBrowser {
  private pages = new Map<Page, Promise<CDPSourcePage>>();
  private disposers = new Set<() => Promise<void>>();
  private closed = false;
  adopt(page: Page, id?: string): Promise<CDPSourcePage> {
    if (this.closed)
      return Promise.reject(new Error('Source browser adapter disposed'));
    const prior = sources.get(page);
    if (prior) return prior;
    const task = this.attach(page, id).catch((error) => {
      this.pages.delete(page);
      sources.delete(page);
      throw error;
    });
    this.pages.set(page, task);
    sources.set(page, task);
    return task;
  }
  private async attach(page: Page, id?: string): Promise<CDPSourcePage> {
    const root = await page.context().newCDPSession(page);
    let source: CDPSourcePage;
    try {
      const target = await root.send('Target.getTargetInfo');
      source = await CDPSourcePage.attach({
        id: id ?? target.targetInfo.targetId,
        transport: root,
        viewport: page.viewportSize() ?? undefined,
        setViewport: (size) => page.setViewportSize(size),
        activate: () => page.bringToFront(),
        close: () => page.close(),
        createPage: async () => this.adopt(await page.context().newPage()),
      });
    } catch (error) {
      await root.detach().catch(() => {});
      throw error;
    }
    const children = new Map<Frame, CDPSession>();
    const pending = new Map<Frame, Promise<void>>();
    let disposed = false;
    const attach = (frame: Frame): Promise<void> => {
      if (
        disposed ||
        frame === page.mainFrame() ||
        frame.isDetached() ||
        children.has(frame)
      )
        return Promise.resolve();
      const prior = pending.get(frame);
      if (prior) return prior;
      const task = (async () => {
        const child = await page
          .context()
          .newCDPSession(frame)
          .catch(() => undefined);
        if (!child) return; // Same-process frames belong to their ancestor session.
        if (disposed || frame.isDetached()) {
          await child.detach().catch(() => {});
          return;
        }
        children.set(frame, child);
        child.on('close', () => {
          if (children.get(frame) === child) children.delete(frame);
          source.removeSession(child);
        });
        try {
          await source.addSession(child);
        } catch {
          children.delete(frame);
          await child.detach().catch(() => {});
        }
      })().finally(() => pending.delete(frame));
      pending.set(frame, task);
      return task;
    };
    const attached = (frame: Frame) => {
      void attach(frame);
    };
    const detached = (frame: Frame) => {
      const child = children.get(frame);
      children.delete(frame);
      if (child) {
        source.removeSession(child);
        void child.detach().catch(() => {});
      }
    };
    const popup = (page: Page) => {
      void this.adopt(page)
        .then((popup) => {
          if (!disposed) source.emit('popup', popup);
        })
        .catch(() => {});
    };
    const crash = () => source.emit('crash');
    const closed = () => {
      source.markClosed();
      void dispose();
    };
    page.on('frameattached', attached);
    page.on('framenavigated', attached);
    page.on('framedetached', detached);
    page.on('popup', popup);
    page.on('crash', crash);
    page.on('close', closed);
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      this.pages.delete(page);
      sources.delete(page);
      this.disposers.delete(dispose);
      page.off('frameattached', attached);
      page.off('framenavigated', attached);
      page.off('framedetached', detached);
      page.off('popup', popup);
      page.off('crash', crash);
      page.off('close', closed);
      await Promise.allSettled(pending.values());
      source.dispose();
      await Promise.allSettled(
        [root, ...children.values()].map((session) => session.detach()),
      );
    };
    this.disposers.add(dispose);
    await Promise.all(page.frames().map(attach));
    if (this.closed || page.isClosed()) {
      await dispose();
      throw new Error('Source page closed during attachment');
    }
    return source;
  }
  /** Detaches owned debugger sessions, never closes host-owned browser pages. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.pages.values());
    await Promise.allSettled([...this.disposers].map((dispose) => dispose()));
    this.pages.clear();
  }
}
