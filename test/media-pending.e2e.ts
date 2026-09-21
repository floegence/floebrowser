import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'buffering source playback does not block input, error feedback or controller shutdown',
  { timeout: 15000 },
  async (t) => {
    const site = createServer((req, res) => {
      if (req.url === '/pending.webm') {
        res.writeHead(200, { 'Content-Type': 'video/webm' });
        res.flushHeaders();
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<video width="320" height="180" src="/pending.webm"></video><button id="count" onclick="this.textContent=String(++window.clicks)">Count</button><script>window.clicks=0</script>',
      );
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await browser.close();
      await service.close();
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    });
    await source.goto(
      `http://127.0.0.1:${(site.address() as AddressInfo).port}`,
      { waitUntil: 'domcontentloaded' },
    );
    const viewer = await browser.newPage();
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .click();
    await viewer
      .getByRole('button', { name: 'Play source media', exact: true })
      .click();
    await source.waitForFunction(
      () => !document.querySelector('video')!.paused,
    );
    await clickProjected(
      viewer.frameLocator('#viewport iframe').locator('#count'),
    );
    await source.waitForFunction(() => (window as any).clicks === 1, null, {
      timeout: 1500,
    });
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .click();
    await viewer
      .getByRole('button', { name: 'Pause source media', exact: true })
      .click();
    await source.waitForFunction(
      () => document.querySelector('video')!.paused,
      null,
      { timeout: 1500 },
    );
    await source.locator('video').evaluate((v: HTMLVideoElement) => {
      v.play = () =>
        Promise.reject(
          new DOMException('Playback requires permission', 'NotAllowedError'),
        );
    });
    await viewer
      .getByRole('button', { name: 'Play source media', exact: true })
      .click();
    await viewer
      .getByText('Playback could not start. Try the page’s play button.', {
        exact: true,
      })
      .waitFor({ timeout: 2000 });
    await clickProjected(
      viewer.frameLocator('#viewport iframe').locator('#count'),
    );
    await source.waitForFunction(() => (window as any).clicks === 2, null, {
      timeout: 1500,
    });
    await source
      .locator('video')
      .evaluate((v: HTMLVideoElement) => delete (v as any).play);
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .click();
    await viewer
      .getByRole('button', { name: 'Play source media', exact: true })
      .click();
    await source.waitForFunction(
      () => !document.querySelector('video')!.paused,
    );
    const start = performance.now();
    await service.close();
    assert.ok(
      performance.now() - start < 1500,
      'Closing control must not wait for media buffering',
    );
  },
);
