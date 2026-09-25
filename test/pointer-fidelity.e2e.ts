import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

// Neutral input geometry fixture: no third-party challenge, recognition or bypass.
for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} preserves trusted image clicks through scaled nested frames`,
    { timeout: 20000 },
    async (t) => {
      const sourceBrowser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() =>
        Promise.all([sourceBrowser.close(), viewerBrowser.close()]),
      );
      const context = await sourceBrowser.newContext();
      await context.route('https://pointer.test/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        const body =
          path === '/'
            ? `<style>body{margin:35px}iframe{width:700px;height:480px;border:7px solid;transform:scale(.8);transform-origin:top left}</style><iframe src="/child"></iframe>`
            : path === '/child'
              ? `<style>body{margin:19px}iframe{width:500px;height:320px;border:5px solid;transform:scale(.85);transform-origin:top left}</style><iframe src="/target"></iframe>`
              : `<style>body{margin:23px}img{display:block;width:320px;height:180px}</style><img id="target" alt="Pointer coordinate fixture" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='seagreen'/%3E%3C/svg%3E"><script>window.events=[];for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])target.addEventListener(type,e=>events.push({type:e.type,trusted:e.isTrusted,x:e.offsetX,y:e.offsetY,buttons:e.buttons}));</script>`;
        return route.fulfill({ contentType: 'text/html', body });
      });
      const source = await context.newPage();
      await source.goto('https://pointer.test/');
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(() => service.close());
      const viewer = await viewerBrowser.newPage({
        viewport: { width: 900, height: 700 },
      });
      viewer.setDefaultTimeout(4000);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const target = viewer
        .frameLocator('#viewport iframe')
        .frameLocator('iframe')
        .frameLocator('iframe')
        .locator('#target');
      const origin = source
        .frames()
        .find((frame) => frame.url().endsWith('/target'))!;
      for (const [x, y] of [
        [41, 32],
        [258, 141],
      ]) {
        // Compare with the same native source-browser gesture. Integer host
        // coordinates are quantized before nested transforms in both paths.
        const native = origin.locator('#target');
        const nativeBounds = await native.boundingBox();
        assert.ok(nativeBounds);
        await source.mouse.click(
          Math.round(nativeBounds.x + (x * nativeBounds.width) / 320),
          Math.round(nativeBounds.y + (y * nativeBounds.height) / 180),
        );
        const expected = await origin.evaluate(() => (window as any).events);
        await origin.evaluate(() => {
          (window as any).events = [];
        });
        const bounds = await target.boundingBox();
        assert.ok(bounds);
        await viewer.mouse.click(
          Math.round(bounds.x + (x * bounds.width) / 320),
          Math.round(bounds.y + (y * bounds.height) / 180),
        );
        await origin.waitForFunction(() => (window as any).events.length === 5);
        const events = await origin.evaluate(
          () =>
            (window as any).events as {
              type: string;
              trusted: boolean;
              x: number;
              y: number;
              buttons: number;
            }[],
        );
        assert.deepEqual(
          events.map((event) => event.type),
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'],
        );
        assert.ok(events.every((event) => event.trusted));
        assert.deepEqual(
          events,
          expected,
          'Projection must deliver exactly the native event coordinates and sequence',
        );
        assert.deepEqual(
          events.map((event) => event.buttons),
          [1, 1, 0, 0, 0],
        );
        await origin.evaluate(() => {
          (window as any).events = [];
        });
      }
    },
  );
