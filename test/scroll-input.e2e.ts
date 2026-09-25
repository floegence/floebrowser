import { hoverProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

async function observeCarrier(viewer: Page) {
  await viewer.addInitScript(() => {
    const state = ((window as any).scrollTest = {
      hold: false,
      events: [] as (() => void)[],
      commands: [] as any[],
      acks: [] as any[],
      resyncs: 0,
      flush() {
        state.hold = false;
        for (const deliver of state.events.splice(0)) deliver();
      },
    });
    const Socket = WebSocket;
    (window as any).WebSocket = class extends Socket {
      send(data: string) {
        const message = JSON.parse(data);
        if (message.type === 'command') state.commands.push(message);
        if (message.type === 'resync') state.resyncs++;
        super.send(data);
      }
      addEventListener(type: string, listener: any, options?: any) {
        if (type !== 'message')
          return super.addEventListener(type, listener, options);
        super.addEventListener(
          type,
          (event: MessageEvent) => {
            const message = JSON.parse(event.data);
            if (message.type === 'ack') state.acks.push(message);
            if (message.type === 'events' && state.hold)
              state.events.push(() => listener(event));
            else listener(event);
          },
          options,
        );
      }
    };
  });
}

test(
  'scaled cross-origin frames scroll in both axes without confusing document and viewport coordinates',
  { timeout: 20000 },
  async (t) => {
    let port = 0;
    const site = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        request.url === '/child'
          ? `<!doctype html><style>body{margin:0;width:10000px}</style>${rows}`
          : `<!doctype html><style>body{margin:0;height:10000px}iframe{width:800px;height:400px;margin:500px 0 0 100px;border:4px solid black}</style><iframe src="http://localhost:${port}/child"></iframe>`,
      );
    });
    await new Promise<void>((resolve) => site.listen(0, resolve));
    t.after(() => {
      site.closeAllConnections();
      site.close();
    });
    port = (site.address() as AddressInfo).port;
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    t.after(() => browser.close());
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    await source.goto(`http://127.0.0.1:${port}`);
    await source.evaluate(() => scrollTo(0, 400));
    const viewer = await browser.newPage({
      viewport: { width: 950, height: 750 },
    });
    viewer.setDefaultTimeout(4000);
    await observeCarrier(viewer);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const frame = viewer
      .frameLocator('#viewport iframe')
      .frameLocator('iframe');
    await hoverProjected(frame.locator('#row1'), {
      position: { x: 200, y: 50 },
    });
    await viewer.evaluate(() => ((window as any).scrollTest.hold = true));
    await scrollBurst(viewer, 120, 150);
    assert.deepEqual(
      await viewer.evaluate(() =>
        (window as any).scrollTest.acks.filter((a: any) => !a.ok),
      ),
      [],
    );
    const child = source.frames().find((frame) => frame.parentFrame())!;
    await child.waitForFunction(
      () => scrollX === 2880 && scrollY === 3600,
      null,
      { timeout: 3000 },
    );
    assert.equal(
      await source.evaluate(() => scrollY),
      400,
      'Scrolling stays in the source child frame',
    );
    await viewer.evaluate(() => (window as any).scrollTest.flush());
    await viewer.waitForFunction(
      () => {
        const child = document
          .querySelector<HTMLIFrameElement>('#viewport iframe')!
          .contentDocument!.querySelector('iframe')!.contentWindow!;
        return child.scrollX === 2880 && child.scrollY === 3600;
      },
      null,
      { timeout: 3000 },
    );
    // An occluding parent overlay must stop wheel input even if the child DOM
    // has not changed and still passes its own local hit test.
    await viewer.evaluate(() => ((window as any).scrollTest.hold = true));
    await source.evaluate(() => {
      const cover = document.createElement('div');
      cover.style.cssText =
        'position:fixed;inset:0;background:white;z-index:10';
      document.body.append(cover);
    });
    await scrollBurst(viewer, 0, 150, 1);
    assert.equal(
      await viewer.evaluate(() => (window as any).scrollTest.acks.at(-1).code),
      'target_changed',
    );
    assert.deepEqual(
      await child.evaluate(() => [scrollX, scrollY]),
      [2880, 3600],
    );
  },
);

for (const change of ['replace', 'cover', 'remove'] as const) {
  test(
    `queued wheel input is rejected after scroll container ${change}`,
    { timeout: 10000 },
    async (t) => {
      const browser = await chromium.launch({
        channel: 'chromium',
        headless: true,
        chromiumSandbox: true,
      });
      t.after(() => browser.close());
      const source = await browser.newPage();
      await source.goto(
        'data:text/html,' +
          encodeURIComponent(
            `<!doctype html><style>body{margin:0;height:10000px}#region{position:absolute;top:20px;left:20px;width:600px;height:500px;overflow:auto}</style><div id="region">${rows}</div>`,
          ),
      );
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(() => service.close());
      const viewer = await browser.newPage();
      await observeCarrier(viewer);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      await hoverProjected(
        viewer.frameLocator('#viewport iframe').locator('#row2'),
      );
      await viewer.evaluate(() => ((window as any).scrollTest.hold = true));
      await source.evaluate((change) => {
        const region = document.querySelector('#region')!;
        if (change === 'remove') region.remove();
        else if (change === 'replace')
          region.replaceWith(region.cloneNode(true));
        else {
          const cover = region.cloneNode(true) as HTMLElement;
          cover.id = 'cover';
          cover.style.cssText =
            'position:fixed;inset:0;overflow:auto;background:white';
          document.body.append(cover);
        }
      }, change);
      await scrollBurst(viewer, 0, 150, 1);
      assert.equal(
        await viewer.evaluate(
          () => (window as any).scrollTest.acks.at(-1).code,
        ),
        'target_changed',
      );
      assert.deepEqual(
        await source.evaluate(() => [
          scrollY,
          document.querySelector('#region')?.scrollTop ?? 0,
          document.querySelector('#cover')?.scrollTop ?? 0,
        ]),
        [0, 0, 0],
      );
    },
  );
}

const rows = Array.from(
  { length: 100 },
  (_, i) => `<p id="row${i}" style="margin:0;height:100px">Row ${i}</p>`,
).join('');

async function scrollBurst(viewer: Page, dx: number, dy: number, count = 24) {
  for (let i = 0; i < count; i++) {
    await viewer.mouse.wheel(dx, dy);
    await new Promise((r) => setTimeout(r, 16));
  }
  await viewer.waitForFunction(() => {
    const state = (window as any).scrollTest;
    return state.commands.length === state.acks.length;
  });
}

for (const layout of ['document', 'nested', 'absolute body'] as const) {
  const nested = layout === 'nested';
  test(
    `continuous ${layout} scrolling tolerates delayed DOM without rejecting input or refreshing`,
    { timeout: 15000 },
    async (t) => {
      const browser = await chromium.launch({
        channel: 'chromium',
        headless: true,
        chromiumSandbox: true,
      });
      let service:
        Awaited<ReturnType<typeof createProjectionServer>> | undefined;
      t.after(async () => {
        await service?.close();
        await browser.close();
      });
      const source = await browser.newPage();
      await source.goto(
        'data:text/html,' +
          encodeURIComponent(
            `${layout === 'absolute body' ? '<!doctype html>' : ''}<style>body{margin:0;${layout === 'absolute body' ? 'position:absolute;width:100%' : ''}}#region{width:700px;height:500px;overflow:auto;border:3px solid black}</style>` +
              (nested ? `<div id="region">${rows}</div>` : rows),
          ),
      );
      if (layout === 'absolute body')
        assert.equal(
          await source.evaluate(
            () => document.documentElement.getBoundingClientRect().height,
          ),
          0,
        );
      service = await createProjectionServer(source, {
        authorize: () => true,
      });
      const viewer = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await observeCarrier(viewer);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      await hoverProjected(
        viewer.frameLocator('#viewport iframe').locator('#row2'),
      );
      await viewer.evaluate(() => ((window as any).scrollTest.hold = true));
      await scrollBurst(viewer, 0, 150);
      const result = await viewer.evaluate(() => {
        const state = (window as any).scrollTest;
        return {
          failures: state.acks.filter((a: any) => !a.ok),
          resyncs: state.resyncs,
          distance: state.commands
            .filter((c: any) => c.action.kind === 'wheel')
            .reduce((sum: number, c: any) => sum + c.action.dy, 0),
        };
      });
      assert.deepEqual(result, { failures: [], resyncs: 0, distance: 3600 });
      await source.waitForFunction(
        (nested) =>
          (nested ? document.querySelector('#region')!.scrollTop : scrollY) ===
          3600,
        nested,
        { timeout: 3000 },
      );
      await viewer.evaluate(() => (window as any).scrollTest.flush());
      await viewer.waitForFunction(
        (nested) => {
          const doc =
            document.querySelector<HTMLIFrameElement>(
              '#viewport iframe',
            )!.contentDocument!;
          return (
            (nested
              ? doc.querySelector('#region')!.scrollTop
              : doc.defaultView!.scrollY) === 3600
          );
        },
        nested,
        { timeout: 3000 },
      );
      assert.equal(
        await viewer.locator('#connection-overlay').isVisible(),
        false,
      );
    },
  );
}

for (const behavior of ['auto', 'contain'] as const)
  test(
    `native scroll chaining respects overscroll behavior ${behavior} at a nested boundary`,
    { timeout: 12000 },
    async (t) => {
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
        await service.close();
        await browser.close();
      });
      await source.goto(
        'data:text/html,' +
          encodeURIComponent(
            `<!doctype html><style>body{margin:0;height:10000px}#region{width:700px;height:500px;overflow:auto;overscroll-behavior:${behavior}}</style><div id="region">${rows.slice(0, rows.indexOf('<p id="row10"'))}</div>${rows}`,
          ),
      );
      const viewer = await browser.newPage();
      await observeCarrier(viewer);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      await hoverProjected(
        viewer.frameLocator('#viewport iframe').locator('#region #row2'),
      );
      await viewer.evaluate(() => ((window as any).scrollTest.hold = true));
      await scrollBurst(viewer, 0, 150);
      assert.deepEqual(
        await viewer.evaluate(() =>
          (window as any).scrollTest.acks.filter((a: any) => !a.ok),
        ),
        [],
      );
      assert.equal(
        await viewer.evaluate(() => (window as any).scrollTest.resyncs),
        0,
      );
      assert.equal(
        await source.locator('#region').evaluate((e) => e.scrollTop),
        500,
      );
      if (behavior === 'auto')
        assert.ok(await source.evaluate(() => scrollY > 1500));
      else assert.equal(await source.evaluate(() => scrollY), 0);
    },
  );
