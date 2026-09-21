#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { launchSourceBrowser } from './browser.js';
import { createProjectionServer } from './server.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    port: { type: 'string', default: '8787' },
    profile: { type: 'string' },
    headed: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(
    'FloeBrowser — a DOM-based remote browser\n\nUsage: floebrowser [--url https://example.com] [--port 8787] [--profile ./profile] [--headed]\n\nThe viewer binds to 127.0.0.1. Keep its private URL secret. Use an SSH tunnel or a host-owned authenticated transport for remote access.',
  );
} else {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Port must be an integer between 0 and 65535.');
  if (values.url && !['http:', 'https:'].includes(new URL(values.url).protocol))
    throw new Error('Only HTTP(S) addresses are supported.');
  const context = await launchSourceBrowser({
    profile: values.profile,
    headless: !values.headed,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  let service: Awaited<ReturnType<typeof createProjectionServer>> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service?.close();
    await context.close();
  };
  try {
    service = await createProjectionServer(page, {
      port,
      authorize: () => true,
    });
    if (values.url)
      await page
        .goto(values.url, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        })
        .catch(() => {
          console.warn(
            'The initial page could not be loaded. Open the viewer to enter another address.',
          );
        });
    console.log(
      `FloeBrowser is ready.\n\nOpen the private viewer:\n${service.url}\n\nSource: ${values.headed ? 'visible' : 'headless'} Chromium · 1280 × 800\nPress Ctrl+C to stop.`,
    );
    process.once('SIGINT', () => {
      void stop();
    });
    process.once('SIGTERM', () => {
      void stop();
    });
  } catch (error) {
    await stop();
    throw error;
  }
}
