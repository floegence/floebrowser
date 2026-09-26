import type {
  BrowserContext,
  CDPSession,
  Frame,
  Page,
  Download,
} from 'playwright';
import { CDPSourcePage } from './cdp-source.js';
import { playwrightDownload } from './downloads.js';
import { closeCDPPage } from './close-page.js';
import {
  consumePopupIntent,
  forgetPopupIntentSource,
  markPopupIntent,
} from './popup-intent.js';

const sources = new WeakMap<Page, Promise<CDPSourcePage>>();

export type PlaywrightSourceOptions = {
  /** The host owns this entire browser window and launches its context with
   * viewport: null. Keep native contents sized for future tabs before their
   * scripts run; borrowed personal tabs must not receive this authority. */
  windowViewport?: boolean;
  /** A host with its own source-scoped download adapter must not also consume
   * Playwright's native handles, which are unavailable in borrowed contexts. */
  nativeDownloads?: boolean;
  /** Embedded hosts decide whether and under which identity to adopt a popup.
   * Providing this callback disables implicit debugger adoption. */
  onPopup?: (
    page: Page,
    opener: CDPSourcePage,
    foreground: boolean,
  ) => void | Promise<void>;
};

/** Optional Playwright lifecycle owner. Consumers share each returned source
 * and its debugger with AI tools; projections never attach a second debugger. */
export class PlaywrightSourceBrowser {
  private pages = new Map<Page, Promise<CDPSourcePage>>();
  private disposers = new Set<() => Promise<void>>();
  private contextListeners = new Map<BrowserContext, (page: Page) => void>();
  private contextWatchers = new Map<
    BrowserContext,
    {
      session: CDPSession;
      onTarget: (event: any) => void;
      intents: Map<string, { source: CDPSourcePage; foreground: boolean }>;
    }
  >();
  private pendingNewTabs = new Map<
    BrowserContext,
    Array<{
      contextID: string;
      url: string;
      source: CDPSourcePage;
      foreground: boolean;
    }>
  >();
  private handledPopups = new WeakSet<Page>();
  private ownedSources = new Set<CDPSourcePage>();
  private closed = false;
  constructor(private options: PlaywrightSourceOptions = {}) {}
  adopt(page: Page, id?: string): Promise<CDPSourcePage> {
    if (this.closed)
      return Promise.reject(new Error('Source browser adapter disposed'));
    const prior = sources.get(page);
    if (prior)
      return prior.then((source) => {
        if (id !== undefined && id !== source.id)
          throw new Error('Source target identity changed');
        return source;
      });
    const task = this.attach(page, id).catch((error) => {
      this.pages.delete(page);
      sources.delete(page);
      throw error;
    });
    this.pages.set(page, task);
    sources.set(page, task);
    return task;
  }
  private async handlePopup(
    page: Page,
    source: CDPSourcePage,
    foreground: boolean,
  ): Promise<void> {
    if (this.options.onPopup) {
      if (!this.closed) await this.options.onPopup(page, source, foreground);
      return;
    }
    const popup = await this.adopt(page);
    if (this.closed) return;
    markPopupIntent(popup, foreground);
    source.emit('popup', popup);
  }
  private async attach(page: Page, id?: string): Promise<CDPSourcePage> {
    const root = await page.context().newCDPSession(page);
    let source: CDPSourcePage;
    let contextID = 'default';
    try {
      const target = await root.send('Target.getTargetInfo');
      contextID = target.targetInfo.browserContextId || 'default';
      source = await CDPSourcePage.attach({
        id: id ?? target.targetInfo.targetId,
        transport: root,
        downloads: true,
        viewport: page.viewportSize() ?? undefined,
        setViewport: async (size, deviceScaleFactor) => {
          if (this.options.windowViewport) {
            const { windowId } = await root.send('Browser.getWindowForTarget');
            await root.send('Browser.setContentsSize', {
              windowId,
              width: Math.round(size.width * deviceScaleFactor),
              height: Math.round(size.height * deviceScaleFactor),
            });
          }
          // Keep Playwright's CSS viewport model aligned with the borrowed CDP
          // owner; source raster density determines responsive assets/canvases.
          await page.setViewportSize(size);
          await root.send('Emulation.setDeviceMetricsOverride', {
            ...size,
            deviceScaleFactor,
            mobile: false,
          });
        },
        activate: () => page.bringToFront(),
        close: () => closeCDPPage(page, root),
        createPage: async () => this.adopt(await page.context().newPage()),
      });
      this.ownedSources.add(source);
    } catch (error) {
      await root.detach().catch(() => {});
      throw error;
    }
    const children = new Map<Frame, CDPSession>();
    const pendingFrames = new Map<Frame, Promise<void>>();
    let disposed = false;
    const attach = (frame: Frame): Promise<void> => {
      if (
        disposed ||
        frame === page.mainFrame() ||
        frame.isDetached() ||
        children.has(frame)
      )
        return Promise.resolve();
      const prior = pendingFrames.get(frame);
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
      })().finally(() => pendingFrames.delete(frame));
      pendingFrames.set(frame, task);
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
      if (this.handledPopups.has(page)) return;
      this.handledPopups.add(page);
      // Chromium reports the popup on the opener. Carry the opener's most
      // recent pointer intent across that boundary before the new source is
      // adopted, otherwise the directory cannot distinguish middle-click
      // background tabs from ordinary foreground popups.
      const foreground = consumePopupIntent(source);
      void this.handlePopup(page, source, foreground).catch(() => {});
    };
    const context = page.context();
    const pendingTabs = this.pendingNewTabs.get(context) ?? [];
    this.pendingNewTabs.set(context, pendingTabs);
    const requestedNewTab = (event: any) => {
      if (event?.disposition !== 'newTab' || typeof event.url !== 'string')
        return;
      pendingTabs.push({
        contextID,
        url: event.url,
        source,
        foreground: consumePopupIntent(source),
      });
      const expiry = setTimeout(() => {
        const index = pendingTabs.findIndex(
          (item) => item.source === source && item.url === event.url,
        );
        if (index >= 0) pendingTabs.splice(index, 1);
      }, 1000);
      (expiry as unknown as { unref?: () => void }).unref?.();
    };
    root.on('Page.frameRequestedNavigation', requestedNewTab);
    const watcher = this.contextWatchers.get(context);
    if (!watcher) {
      const session = await context.browser()!.newBrowserCDPSession();
      const intents = new Map<
        string,
        { source: CDPSourcePage; foreground: boolean }
      >();
      const onTarget = (event: any) => {
        const target = event?.targetInfo;
        if (!target || target.type !== 'page' || target.openerId) return;
        const tabs = this.pendingNewTabs.get(context) ?? [];
        const index = tabs.findIndex(
          (item) => item.contextID === (target.browserContextId || 'default'),
        );
        if (index < 0) return;
        const item = tabs.splice(index, 1)[0]!;
        intents.set(target.targetId, {
          source: item.source,
          foreground: item.foreground,
        });
      };
      await session.send('Target.setDiscoverTargets', { discover: true });
      session.on('Target.targetCreated', onTarget);
      this.contextWatchers.set(context, { session, onTarget, intents });
    }
    if (!this.contextListeners.has(context)) {
      const contextPage = (popupPage: Page) => {
        if (this.closed || this.handledPopups.has(popupPage)) return;
        // Let a normal page-level popup event win when Chromium exposes an
        // opener. Middle-click tabs are admitted only when Chromium first
        // reported a source navigation with `disposition: newTab` and the
        // browser target watcher matched its native target ID.
        setTimeout(() => {
          if (this.closed || this.handledPopups.has(popupPage)) return;
          void (async () => {
            const opener = await popupPage.opener().catch(() => null);
            const openerTask = opener ? this.pages.get(opener) : undefined;
            if (openerTask) {
              // A page-level popup handler may still be delivered just after
              // this context event. Leave it to that handler when no intent is
              // available yet; unmarked browser pages are not admitted.
              const source = await openerTask.catch(() => undefined);
              if (source && this.handledPopups.has(popupPage)) return;
            }
            const probe = await popupPage
              .context()
              .newCDPSession(popupPage)
              .catch(() => undefined);
            const target = await probe
              ?.send('Target.getTargetInfo')
              .catch(() => undefined);
            await probe?.detach().catch(() => {});
            const intent = target
              ? this.contextWatchers
                  .get(context)
                  ?.intents.get(target.targetInfo.targetId)
              : undefined;
            if (!target || !intent) return;
            const targetID = target.targetInfo.targetId;
            this.contextWatchers.get(context)?.intents.delete(targetID);
            this.handledPopups.add(popupPage);
            void this.handlePopup(popupPage, intent.source, intent.foreground);
          })().catch(() => {});
        }, 0);
      };
      context.on('page', contextPage);
      this.contextListeners.set(context, contextPage);
    }
    const crash = () => source.emit('crash');
    const download = (file: Download) =>
      source.reportDownload(playwrightDownload(file));
    // Playwright otherwise auto-dismisses website dialogs before the shared
    // debugger owner can present them to the authorized controller.
    const dialog = () => {};
    const closed = () => {
      source.markClosed();
      void dispose();
    };
    page.on('frameattached', attached);
    page.on('framenavigated', attached);
    page.on('framedetached', detached);
    page.on('popup', popup);
    page.on('crash', crash);
    if (this.options.nativeDownloads !== false) page.on('download', download);
    page.on('dialog', dialog);
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
      page.off('download', download);
      page.off('dialog', dialog);
      page.off('close', closed);
      root.off('Page.frameRequestedNavigation', requestedNewTab);
      await Promise.allSettled(pendingFrames.values());
      source.dispose();
      this.ownedSources.delete(source);
      forgetPopupIntentSource(source);
      await Promise.allSettled(
        [root, ...children.values()].map((session) => session.detach()),
      );
      if (
        ![...this.pages.keys()].some(
          (candidate) => candidate.context() === context,
        )
      ) {
        const listener = this.contextListeners.get(context);
        if (listener) context.off('page', listener);
        this.contextListeners.delete(context);
        const watcher = this.contextWatchers.get(context);
        if (watcher) {
          watcher.session.off('Target.targetCreated', watcher.onTarget);
          void watcher.session.detach().catch(() => {});
          this.contextWatchers.delete(context);
        }
        this.pendingNewTabs.delete(context);
      }
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

/** Chromium owns the beforeunload decision. Keep directory membership until
 * either the target actually closes or the user cancels that close. */
