import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/index.js';

for (const client of [chromium, firefox, webkit]) {
  test(
    `a ${client.name()} child browser receives only credited projection ports and preserves source effects`,
    { timeout: 20000 },
    async (t) => {
      const sourceBrowser = await chromium.launch();
      t.after(() => sourceBrowser.close());
      const viewerBrowser = await client.launch();
      t.after(() => viewerBrowser.close());
      const source = await sourceBrowser.newPage();
      await source.goto(
        "data:text/html,<script>window.sourceOnly=1</script><button onclick=\"document.querySelector('output').textContent=Number(document.querySelector('output').textContent)+1\">Count</button><output>0</output>",
      );
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(async () => {
        await service.close();
      });
      const bundle = await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
      import { mountBrowser, webSocketConnection, projectionPortConnection, serveProjectionPorts } from './src/viewer/index.js';
      const base = ${JSON.stringify(service.url)};
      if (location.pathname.endsWith('/port-parent')) {
        const frame = document.querySelector('iframe');
        window.addEventListener('message', event => {
          if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data !== 'browser-ready') return;
          const messages = new MessageChannel(), media = new MessageChannel();
          const host = serveProjectionPorts({ messages: messages.port1, media: media.port1 }, () => webSocketConnection(base.replace('http:', 'ws:') + 'stream'));
          window.stopBrowser = () => host.close();
          frame.contentWindow.postMessage('browser-ports', location.origin, [messages.port2, media.port2]);
        });
        frame.src = base + 'port-child';
      } else {
        window.addEventListener('message', event => {
          if (event.source !== parent || event.origin !== location.origin || event.data !== 'browser-ports' || event.ports.length !== 2) return;
          const connection = projectionPortConnection({ messages: event.ports[0], media: event.ports[1] });
          mountBrowser(document.body, { connect: () => connection, mediaAssets: { decoderURL: base + 'media-worker.js', audioWorkletURL: base + 'audio-worklet.js' } });
        }, { once: true });
        parent.postMessage('browser-ready', location.origin);
      }
    `,
        },
        bundle: true,
        format: 'iife',
        write: false,
      });
      const viewer = await viewerBrowser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      // Chromium classifies route.fulfill documents as public-network responses.
      // This fixture explicitly permits its local demo carrier; product bridges
      // receive a host-owned connection and do not make loopback requests.
      if (client === chromium)
        await viewer.context().grantPermissions(['local-network-access'], {
          origin: new URL(service.url).origin,
        });
      viewer.setDefaultTimeout(5000);
      const errors: string[] = [];
      viewer.on('pageerror', (error) => {
        errors.push(error.message);
        t.diagnostic(error.stack ?? error.message);
      });
      await viewer.route(service.url + 'port-*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<link rel="stylesheet" href="${service.url}app.css"><style>html,body{margin:0;height:100%;width:100%}#browser-window{width:100%;height:100%;border:0}</style>${route.request().url().endsWith('port-parent') ? '<iframe id="browser-window" sandbox="allow-scripts allow-same-origin allow-downloads"></iframe>' : ''}<script>${bundle.outputFiles[0]!.text}</script>`,
        }),
      );
      await viewer.goto(service.url + 'port-parent');
      const child = viewer.frameLocator('#browser-window');
      try {
        await child.locator('[data-floe-ui=status].live').waitFor();
      } catch (error) {
        for (const frame of viewer.frames())
          t.diagnostic(
            JSON.stringify({
              url: frame.url(),
              status: await frame
                .locator('[data-floe-ui=status]')
                .evaluateAll((elements) =>
                  elements.map((element) => ({
                    text: element.textContent,
                    class: element.className,
                  })),
                ),
              body: (await frame.locator('body').innerText()).slice(0, 500),
            }),
          );
        throw error;
      }
      const projection = child.frameLocator('[data-floe-ui=viewport] iframe');
      await projection.getByRole('button', { name: 'Count' }).click();
      await source.waitForFunction(
        () => document.querySelector('output')!.textContent === '1',
      );
      await projection.locator('output').filter({ hasText: '1' }).waitFor();
      assert.equal(
        await projection
          .locator('body')
          .evaluate(
            (body) => (body.ownerDocument.defaultView as any).sourceOnly,
          ),
        undefined,
        'Website JavaScript does not run in the projection',
      );
      await viewer.evaluate(() => (window as any).stopBrowser());
      await child.locator('[data-floe-ui=status].disconnected').waitFor();
      assert.equal(source.isClosed(), false);
      assert.equal(await source.locator('output').textContent(), '1');
      assert.deepEqual(errors, []);
    },
  );
}
