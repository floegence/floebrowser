import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

for (const isolated of [false, true])
  test(
    `projects nested frames with source-only resources, input and navigation: isolated=${isolated}`,
    { timeout: 30000 },
    async () => {
      let port = 0;
      const site = createServer((request, response) => {
        if (request.url === '/image.svg') {
          response.setHeader('Content-Type', 'image/svg+xml');
          response.end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42"><rect width="42" height="42" fill="green"/></svg>',
          );
          return;
        }
        response.setHeader('Content-Type', 'text/html');
        if (request.url === '/inner') {
          response.end(
            '<h2>Nested frame</h2><input id="nested"><button onclick="this.textContent=event.isTrusted ? \'Trusted nested click\' : \'Untrusted\'">Nested action</button>',
          );
        } else if (request.url === '/next') {
          response.end(
            `<h2>Frame navigation complete</h2><a href="http://127.0.0.1:${port}/return">Return same-origin</a>`,
          );
        } else if (request.url === '/return') {
          response.end(
            `<h2>Same-origin return</h2><a href="http://localhost:${port}/frame">Cross-site again</a>`,
          );
        } else if (request.url === '/frame') {
          response.end(
            `<style>body{background:rgb(232, 242, 252)}</style><h2>Cross-site content</h2><img src="/image.svg"><button id="action" onclick="this.textContent=event.isTrusted ? 'Trusted frame click' : 'Untrusted'">Frame action</button><input id="entry"><a href="/next">Frame next page</a><iframe title="Nested source" src="/inner" style="width:500px;height:180px"></iframe><script>window.sourceExecution=true</script>`,
          );
        } else {
          response.end(
            `<h1>Main document stays here</h1><iframe id="remote" title="Cross-site source" src="http://localhost:${port}/frame" style="width:680px;height:420px;border:4px solid gray"></iframe>`,
          );
        }
      });
      await new Promise<void>((resolve) => site.listen(0, resolve));
      port = (site.address() as AddressInfo).port;
      const browser = await chromium.launch({
        chromiumSandbox: true,
        ...(isolated
          ? { channel: 'chromium', args: ['--site-per-process'] }
          : {}),
      });
      const source = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      const page = await source.newPage();
      page.setDefaultTimeout(5000);
      const service = await createProjectionServer(page, {
        authorize: () => true,
      });
      try {
        await page.goto(`http://127.0.0.1:${port}/`, {
          waitUntil: 'networkidle',
        });
        const viewer = await browser.newPage({
          viewport: { width: 1440, height: 1080 },
        });
        viewer.setDefaultTimeout(5000);
        const externalRequests: string[] = [];
        await viewer.route('**/*', (route) => {
          if (
            new URL(route.request().url()).origin !==
            new URL(service.url).origin
          ) {
            externalRequests.push(route.request().url());
            return route.abort();
          }
          return route.continue();
        });
        await viewer.goto(service.url);
        const root = viewer.frameLocator('#viewport iframe').first();
        await root
          .getByRole('heading', { name: 'Main document stays here' })
          .waitFor();
        const frame = root.frameLocator('#remote');
        await frame
          .getByRole('heading', { name: 'Cross-site content' })
          .waitFor({ timeout: 7000 });
        assert.equal(
          await frame
            .locator('body')
            .evaluate(() => (window as any).sourceExecution),
          undefined,
        );
        await frame
          .locator('img')
          .evaluate((image: HTMLImageElement) => image.decode());
        assert.equal(
          await frame
            .locator('img')
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
          42,
        );
        assert.equal(
          await root.locator('#remote').getAttribute('sandbox'),
          'allow-same-origin',
        );
        await clickProjected(
          frame.getByRole('button', { name: 'Frame action', exact: true }),
        );
        await frame
          .getByRole('button', { name: 'Trusted frame click' })
          .waitFor();
        await clickProjected(frame.locator('#entry'));
        await viewer.keyboard.type('source text');
        await page
          .frameLocator('#remote')
          .locator('#entry')
          .evaluate(async (input: HTMLInputElement) => {
            const deadline = Date.now() + 4000;
            while (input.value !== 'source text' && Date.now() < deadline)
              await new Promise((r) => setTimeout(r, 20));
          });
        assert.equal(
          await page.frameLocator('#remote').locator('#entry').inputValue(),
          'source text',
        );
        const nested = frame.frameLocator('iframe');
        await clickProjected(
          nested.getByRole('button', { name: 'Nested action' }),
        );
        await nested
          .getByRole('button', { name: 'Trusted nested click' })
          .waitFor();
        await clickProjected(nested.locator('#nested'));
        await viewer.keyboard.insertText('Nested text');
        await page
          .frameLocator('#remote')
          .frameLocator('iframe')
          .locator('#nested')
          .evaluate(async (input: HTMLInputElement) => {
            const deadline = Date.now() + 4000;
            while (input.value !== 'Nested text' && Date.now() < deadline)
              await new Promise((r) => setTimeout(r, 20));
          });
        assert.equal(
          await page
            .frameLocator('#remote')
            .frameLocator('iframe')
            .locator('#nested')
            .inputValue(),
          'Nested text',
        );
        await clickProjected(
          frame.getByText('Frame next page', { exact: true }),
        );
        await frame
          .getByRole('heading', { name: 'Frame navigation complete' })
          .waitFor();
        await root
          .getByRole('heading', { name: 'Main document stays here' })
          .waitFor();
        await clickProjected(
          frame.getByText('Return same-origin', { exact: true }),
        );
        await frame
          .getByRole('heading', { name: 'Same-origin return' })
          .waitFor();
        await clickProjected(
          frame.getByText('Cross-site again', { exact: true }),
        );
        await frame
          .getByRole('heading', { name: 'Cross-site content' })
          .waitFor();
        await viewer.reload();
        await frame
          .getByRole('heading', { name: 'Cross-site content' })
          .waitFor();
        await clickProjected(
          frame.getByRole('button', { name: 'Frame action', exact: true }),
        );
        await frame
          .getByRole('button', { name: 'Trusted frame click' })
          .waitFor();
        assert.deepEqual(externalRequests, []);
      } finally {
        await service.close();
        await browser.close();
        site.closeAllConnections();
        await new Promise<void>((resolve) => site.close(() => resolve()));
      }
    },
  );
