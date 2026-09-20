import { chromium, type BrowserContext } from 'playwright';
import { resolve } from 'node:path';

/** A managed full Chromium; no system Chrome or display server is required. */
export async function launchSourceBrowser(
  options: {
    profile?: string;
    headless?: boolean;
  } = {},
): Promise<BrowserContext> {
  const launch = {
    channel: 'chromium',
    headless: options.headless ?? true,
    chromiumSandbox: true,
    // The source is a user-controlled browser. Explicit WebDriver markers can
    // cause sites to reject its playback sessions; other detection remains possible.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
  const browser = await chromium.launch(launch);
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { userAgent } = await cdp.send('Browser.getVersion');
    await cdp.detach();
    // Keep the actual Chromium version/platform. Some sites reject the shell
    // product token before serving any document. This is not bot invisibility.
    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      userAgent: userAgent.replace('HeadlessChrome/', 'Chrome/'),
    };
    if (options.profile) {
      await browser.close();
      return await chromium.launchPersistentContext(resolve(options.profile), {
        ...launch,
        ...contextOptions,
      });
    }
    const context = await browser.newContext(contextOptions);
    context.once('close', () => {
      void browser.close();
    });
    return context;
  } catch (error) {
    await browser.close();
    throw error;
  }
}
