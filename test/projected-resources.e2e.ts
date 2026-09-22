import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/index.js';
import { clickProjected } from './projected-input.js';

for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} resolves resources in the trusted document without blocking input or enabling replay scripts`,
    { timeout: 30000 },
    async (t) => {
      const site = http.createServer((request, response) => {
        if (request.url?.endsWith('.svg')) {
          response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
          response.end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="32"><rect width="44" height="32" fill="green"/></svg>',
          );
        } else if (request.url === '/nested.css') {
          response.writeHead(200, { 'Content-Type': 'text/css' });
          response.end(
            '#background { background-image: url(/background.svg); width: 44px; height:32px }',
          );
        } else {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end(
            '<!doctype html><style>@import "/nested.css";button{font-size:24px}</style><img id="image" src="/picture.svg"><div id="background"></div><button onclick="this.textContent=`Count ${++window.count}`">Count 0</button><script>window.count=0;window.sourceOnly=true</script>',
          );
        }
      });
      site.listen(0, '127.0.0.1');
      await once(site, 'listening');
      t.after(() => {
        site.closeAllConnections();
        site.close();
      });
      const sourceBrowser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() => viewerBrowser.close());
      const source = await sourceBrowser.newPage();
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(async () => {
        await service.close();
        await sourceBrowser.close();
      });
      await source.goto(
        `http://127.0.0.1:${(site.address() as { port: number }).port}`,
      );
      const viewer = await viewerBrowser.newPage();
      viewer.on('pageerror', (error) =>
        console.error('resource viewer', error.message),
      );
      const resources: string[] = [],
        forbidden: string[] = [];
      let hold = false,
        delayed!: () => void,
        unblock!: () => void;
      const pending = new Promise<void>((resolve) => {
        delayed = resolve;
      });
      const released = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      t.after(() => unblock());
      await viewer.route('**/*', async (route) => {
        const request = route.request();
        if (new URL(request.url()).origin !== new URL(service.url).origin) {
          forbidden.push(request.url());
          await route.abort();
          return;
        }
        if (
          /\/session\/[^/]+\/assets\//u.test(new URL(request.url()).pathname)
        ) {
          resources.push(request.url());
          assert.equal(request.resourceType(), 'fetch');
          assert.equal(
            request.frame(),
            viewer.mainFrame(),
            'inert frames never request HTTP resources',
          );
          if (hold) {
            delayed();
            await released;
          }
        }
        await route.continue().catch(() => {});
      });
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor({ timeout: 12000 });
      const replay = viewer.frameLocator('iframe');
      await replay
        .locator('#image')
        .evaluate((image) => (image as HTMLImageElement).decode());
      assert.equal(
        await replay
          .locator('#image')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
        44,
      );
      assert.match(
        (await replay.locator('#image').getAttribute('src')) ?? '',
        /^blob:/u,
      );
      assert.match(
        await replay
          .locator('#background')
          .evaluate((node) => getComputedStyle(node).backgroundImage),
        /blob:/u,
      );
      assert.equal(
        await replay.locator('body').evaluate(() => (window as any).sourceOnly),
        undefined,
      );
      hold = true;
      await source.evaluate(() => {
        const image = document.createElement('img');
        image.id = 'slow';
        image.src = '/late.svg';
        document.body.append(image);
      });
      await Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Late resource not requested')),
            3000,
          ),
        ),
      ]);
      await clickProjected(replay.locator('button'));
      await replay
        .getByText('Count 1', { exact: true })
        .waitFor({ timeout: 1500 });
      unblock();
      hold = false;
      await replay
        .locator('#slow')
        .evaluate((image) => (image as HTMLImageElement).decode());
      assert.equal(await source.locator('button').textContent(), 'Count 1');
      assert.ok(resources.length >= 3);
      assert.deepEqual(forbidden, []);
    },
  );
