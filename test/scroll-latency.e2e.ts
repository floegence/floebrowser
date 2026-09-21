import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

// Observe actual browser positions and carrier timing, without changing replay.
async function observe(viewer: Page, layout: string) {
  await viewer.addInitScript((layout) => {
    // tsx names nested callbacks; Playwright serializes this function in isolation.
    (window as any).__name = (value: unknown) => value;
    const state = ((window as any).latency = {
      commands: [] as any[],
      acks: [] as any[],
      delivered: [] as any[],
      samples: [] as any[],
      inputs: [] as any[],
      total: 0,
      resyncs: 0,
      position() {
        let doc =
          document.querySelector<HTMLIFrameElement>(
            '#viewport iframe',
          )?.contentDocument;
        if (layout === 'frame')
          doc = doc?.querySelector('iframe')?.contentDocument;
        return layout === 'nested'
          ? doc?.querySelector('#region')?.scrollTop
          : doc?.defaultView?.scrollY;
      },
    });
    const Socket = WebSocket;
    (window as any).WebSocket = class extends Socket {
      send(data: string) {
        const message = JSON.parse(data);
        if (message.type === 'command')
          state.commands.push({ ...message, at: Date.now() });
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
            if (message.type === 'ack')
              state.acks.push({ ...message, at: Date.now() });
            listener(event);
            for (const e of message.type === 'events' ? message.events : []) {
              if (e.type !== 3 || e.data.source !== 3) continue;
              const sample = {
                target: e.data.y,
                source: e.timestamp,
                received: Date.now(),
                painted: 0,
                actual: 0,
              };
              state.delivered.push(sample);
              requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    sample.painted = Date.now();
                    sample.actual = state.position() ?? -1;
                  }),
                ),
              );
            }
          },
          options,
        );
      }
    };
    const sample = () => {
      state.samples.push({ at: Date.now(), y: state.position() });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, layout);
}

const content = `<style>html, #region{scroll-behavior:smooth}body{margin:0}#region{height:500px;overflow:auto}p{margin:0;height:100px}</style>${Array.from({ length: 200 }, (_, i) => `<p>Row ${i}</p>`).join('')}`;

for (const layout of ['document', 'nested', 'frame']) {
  test(
    `live ${layout} scrolling displays each delivered position without a second animation`,
    { timeout: 20000 },
    async (t) => {
      let port = 0;
      const site = createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          `<!doctype html>${req.url === '/child' || layout === 'document' ? content : layout === 'nested' ? `<div id="region">${content}</div>` : `<iframe style="width:900px;height:550px" src="http://localhost:${port}/child"></iframe>`}`,
        );
      });
      await new Promise<void>((r) => site.listen(0, r));
      port = (site.address() as AddressInfo).port;
      const browser = await chromium.launch({
        channel: 'chromium',
        headless: true,
        chromiumSandbox: true,
      });
      const source = await browser.newPage();
      await source.goto(`http://127.0.0.1:${port}`);
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(async () => {
        await service.close();
        await browser.close();
        site.closeAllConnections();
        site.close();
      });
      const viewer = await browser.newPage();
      await observe(viewer, layout);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const projected =
        layout === 'frame'
          ? viewer.frameLocator('#viewport iframe').frameLocator('iframe')
          : viewer.frameLocator('#viewport iframe');
      await projected.locator('p').first().waitFor();
      const frame =
        layout === 'frame'
          ? source.frames().find((f) => f.parentFrame())!
          : source.mainFrame();
      for (const y of [900, 300, 1800]) {
        await frame.evaluate(
          ({ layout, y }) => {
            const region =
              layout === 'nested' ? document.querySelector('#region')! : window;
            region.scrollTo({ top: y, behavior: 'instant' });
          },
          { layout, y },
        );
        await viewer.waitForFunction(
          (y) =>
            (window as any).latency.delivered.some(
              (s: any) => s.target === y && s.painted,
            ),
          y,
        );
        const sample = await viewer.evaluate(
          (y) =>
            (window as any).latency.delivered.find((s: any) => s.target === y),
          y,
        );
        t.diagnostic(
          JSON.stringify({
            layout,
            ...sample,
            transportMs: sample.received - sample.source,
            visibleMs: sample.painted - sample.source,
          }),
        );
        assert.equal(
          sample.actual,
          y,
          'The source position must be visible within three viewer animation frames, even with source CSS smooth scrolling',
        );
      }
    },
  );
}

test(
  'sustained wheel input keeps source and viewer progress bounded and preserves reversal and clicks',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    const source = await browser.newPage();
    await source.goto(
      'data:text/html,' +
        encodeURIComponent(
          `<!doctype html>${content}<button id="click" style="position:fixed;top:10px;left:20px" onclick="this.textContent='Clicked'">Click</button>`,
        ),
    );
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const viewer = await browser.newPage();
    await observe(viewer, 'document');
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await source.evaluate(() => {
      (window as any).scrollSamples = [];
      addEventListener('scroll', () =>
        (window as any).scrollSamples.push({ at: Date.now(), y: scrollY }),
      );
    });
    for (const dy of [30, -30]) {
      await viewer.evaluate(async (dy) => {
        const surface = document.querySelector<HTMLElement>(
          '.floe-input-surface',
        )!;
        const origin = surface.getBoundingClientRect();
        for (let n = 0; n < 80; n++) {
          const state = (window as any).latency;
          state.total += dy;
          state.inputs.push({
            at: Date.now(),
            target: state.total,
            direction: Math.sign(dy),
          });
          surface.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: origin.left + 300,
              clientY: origin.top + 300,
              deltaY: dy,
            }),
          );
          await new Promise((r) => setTimeout(r, 8));
        }
      }, dy);
      const target = dy > 0 ? 2400 : 0;
      await source.waitForFunction((y) => scrollY === y, target, {
        timeout: 4000,
      });
      await viewer.waitForFunction(
        (y) => (window as any).latency.position() === y,
        target,
        { timeout: 4000 },
      );
    }
    await clickProjected(
      viewer.frameLocator('#viewport iframe').locator('#click'),
    );
    await source.getByText('Clicked', { exact: true }).waitFor();
    const result = await viewer.evaluate(() => {
      const state = (window as any).latency;
      const wheels = state.commands.filter(
        (c: any) => c.action.kind === 'wheel',
      );
      const latencies = wheels.map(
        (c: any) => state.acks.find((a: any) => a.id === c.id)?.at - c.at,
      );
      const samples = state.delivered.filter(
        (e: any) => e.target > 0 && e.target < 2400,
      );
      return {
        commands: wheels.length,
        failures: state.acks.filter((a: any) => !a.ok),
        resyncs: state.resyncs,
        inputs: state.inputs,
        samples: state.samples,
        ackTimes: latencies,
        transportTimes: samples.map((e: any) => e.received - e.source),
      };
    });
    const quantile = (values: number[]) =>
      values.sort((a, b) => a - b)[Math.floor((values.length - 1) * 0.95)];
    const sourceSamples = await source.evaluate(
      () => (window as any).scrollSamples,
    );
    const inputLatency = (samples: Array<{ at: number; y: number }>) =>
      result.inputs.map(
        (input: { at: number; target: number; direction: number }) => {
          const match = samples.find(
            (sample) =>
              sample.at >= input.at &&
              (input.direction > 0
                ? sample.y >= input.target
                : sample.y <= input.target),
          );
          assert.ok(match, 'Every input distance becomes observable');
          return match.at - input.at;
        },
      );
    t.diagnostic(
      JSON.stringify({
        commands: result.commands,
        failures: result.failures,
        ackP95: quantile(result.ackTimes),
        ackMax: Math.max(...result.ackTimes),
        transportP95: quantile(result.transportTimes),
        inputToSourceP95: quantile(inputLatency(sourceSamples)),
        inputToViewP95: quantile(inputLatency(result.samples)),
      }),
    );
    assert.ok(result.commands > 0 && result.commands <= 160);
    assert.deepEqual(result.failures, []);
    assert.equal(result.resyncs, 0);
  },
);

for (const ending of [
  'release',
  'barriers',
  'denied',
  'navigation',
  'handoff',
] as const) {
  test(
    `pending wheel increments remain bounded with ${ending}`,
    { timeout: 15000 },
    async (t) => {
      const browser = await chromium.launch({
        channel: 'chromium',
        headless: true,
        chromiumSandbox: true,
      });
      const source = await browser.newPage();
      await source.goto(
        'data:text/html,' +
          encodeURIComponent(
            `<!doctype html>${content}<button id="click" style="position:fixed;top:10px;left:20px" onclick="this.textContent='Clicked'">Click</button>`,
          ),
      );
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let first = true;
      const authorized: any[] = [];
      const service = await createProjectionServer(source, {
        authorize: async (action) => {
          authorized.push(action);
          if (action.kind === 'wheel' && first) {
            first = false;
            await gate;
            return ending !== 'denied';
          }
          return true;
        },
      });
      t.after(async () => {
        release();
        await service.close();
        await browser.close();
      });
      const viewer = await browser.newPage();
      await observe(viewer, 'document');
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      // Finish the initial auto resize before holding the serialized input path.
      await viewer.waitForFunction(() => {
        const s = (window as any).latency;
        return (
          s.commands.some((c: any) => c.action.kind === 'viewport') &&
          s.commands.length === s.acks.length
        );
      });
      await viewer.evaluate(() => {
        const surface = document.querySelector<HTMLElement>(
          '.floe-input-surface',
        )!;
        const origin = surface.getBoundingClientRect();
        for (let n = 0; n < 80; n++)
          surface.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: origin.left + 300,
              clientY: origin.top + 300,
              deltaY: 20,
            }),
          );
      });
      assert.equal(
        await viewer.evaluate(
          () =>
            (window as any).latency.commands.filter(
              (c: any) => c.action.kind === 'wheel',
            ).length,
        ),
        1,
        'A held source keeps one wheel in flight regardless of gesture frequency',
      );
      let next: Page | undefined;
      if (ending === 'barriers') {
        await viewer.evaluate(() => {
          const surface = document.querySelector<HTMLElement>(
            '.floe-input-surface',
          )!;
          const origin = surface.getBoundingClientRect();
          for (let n = 0; n < 10; n++)
            surface.dispatchEvent(
              new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX: origin.left + 300,
                clientY: origin.top + 300,
                deltaY: -20,
              }),
            );
        });
        await clickProjected(
          viewer.frameLocator('#viewport iframe').locator('#click'),
        );
      } else if (ending === 'navigation') {
        await source.goto(
          'data:text/html,' +
            encodeURIComponent(
              `<!doctype html><title>New document</title>${content}`,
            ),
        );
        await viewer
          .getByRole('tab', { name: 'New document', exact: true })
          .waitFor();
      } else if (ending === 'handoff') {
        next = await browser.newPage();
        await next.goto(service.url);
        await next
          .getByRole('button', { name: 'Use in this window', exact: true })
          .click();
        await viewer.locator('#status.disconnected').waitFor();
      }
      release();
      if (ending === 'release' || ending === 'barriers') {
        const target = ending === 'release' ? 1600 : 1400;
        await source.waitForFunction((target) => scrollY === target, target);
        await viewer.waitForFunction(
          (target) => (window as any).latency.position() === target,
          target,
        );
        const wheels = authorized.filter((a) => a.kind === 'wheel');
        assert.deepEqual(
          wheels.map((a) => a.dy),
          ending === 'release' ? [20, 1580] : [20, 1580, -200],
        );
        if (ending === 'barriers') {
          await source.getByText('Clicked', { exact: true }).waitFor();
          assert.ok(
            authorized.findIndex(
              (a) => a.kind === 'pointer' && a.phase === 'down',
            ) > authorized.findLastIndex((a) => a.kind === 'wheel'),
          );
        }
      } else {
        if (next) await next.locator('#status.live').waitFor();
        else
          await viewer.waitForFunction(() => {
            const s = (window as any).latency;
            return s.commands.length === s.acks.length;
          });
        // An input barrier gives any wrongly retained wheel a chance to dispatch.
        await clickProjected(
          (next ?? viewer)
            .frameLocator('#viewport iframe')
            .locator('p')
            .first(),
        );
        assert.equal(
          await viewer.evaluate(
            () =>
              (window as any).latency.commands.filter(
                (c: any) => c.action.kind === 'wheel',
              ).length,
          ),
          1,
          'Unsent increments cannot leak past rejection, a new document or controller handoff',
        );
        assert.equal(await source.evaluate(() => scrollY), 0);
      }
    },
  );
}
