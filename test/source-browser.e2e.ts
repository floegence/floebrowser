import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { launchSourceBrowser } from '../dist/host/browser.js';

test('managed headless Chromium uses its actual Chrome UA and preserves a dedicated profile', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'floe-source-profile-'));
  const requests: Array<{ ua?: string; cookie?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      ua: request.headers['user-agent'],
      cookie: request.headers.cookie,
    });
    response.setHeader(
      'Set-Cookie',
      'floe=retained; Max-Age=86400; HttpOnly; Path=/',
    );
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Source browser fixture</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (let i = 0; i < 2; i++) {
      const context = await launchSourceBrowser({ profile });
      try {
        const page = context.pages()[0]!;
        await page.goto(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        );
        const ua = await page.evaluate(() => navigator.userAgent);
        assert.doesNotMatch(ua, /HeadlessChrome/);
        assert.match(ua, /Chrome\/\d+/);
        assert.equal(requests.at(-1)!.ua, ua);
        if (i) assert.match(requests.at(-1)!.cookie ?? '', /floe=retained/);
      } finally {
        await context.close();
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
