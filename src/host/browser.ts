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
    // Keep the explicit automation-marker policy consistent with the managed
    // source. This does not alter the native UA/client hints or promise site
    // admission; challenge providers may still reject automation.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
  // Keep Chromium's native UA and client hints together. Passing a reduced UA
  // through Playwright makes it infer the OS and CPU from compatibility tokens,
  // replacing real platform metadata even when the UA string is unchanged.
  // New tabs inherit native window dimensions before website scripts run.
  const contextOptions = { viewport: null };
  if (options.profile)
    return chromium.launchPersistentContext(resolve(options.profile), {
      ...launch,
      ...contextOptions,
    });
  const browser = await chromium.launch(launch);
  try {
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
