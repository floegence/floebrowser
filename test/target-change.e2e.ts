import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { clickProjected } from './projected-input.js';

for (const change of ['replace', 'cover', 'remove'] as const)
  test(
    `${change}: a changed pointer target cancels only that gesture and preserves scrolling`,
    { timeout: 15000 },
    async (t) => {
      const browser = await chromium.launch({ chromiumSandbox: true });
      const source = await browser.newPage();
      await source.goto(
        'data:text/html,' +
          encodeURIComponent(
            `<!doctype html><style>body{margin:0;height:12000px}button{position:fixed;top:100px;left:100px;width:200px;height:60px}</style><button id="target" onclick="window.clicks++">Original</button><script>window.clicks=0</script>`,
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
      viewer.setDefaultTimeout(4000);
      await viewer.addInitScript(() => {
        const state = ((window as any).targetTest = {
          hold: false,
          events: [] as (() => void)[],
          acks: [] as any[],
          resyncs: 0,
          snapshots: 0,
          flush() {
            state.hold = false;
            for (const deliver of state.events.splice(0)) deliver();
          },
        });
        const Socket = WebSocket;
        (window as any).WebSocket = class extends Socket {
          send(data: string) {
            if (JSON.parse(data).type === 'resync') state.resyncs++;
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
                if (message.type === 'snapshot') state.snapshots++;
                if (message.type === 'events' && state.hold)
                  state.events.push(() => listener(event));
                else listener(event);
              },
              options,
            );
          }
        };
      });
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      await viewer.evaluate(() => ((window as any).targetTest.hold = true));
      await source.evaluate((change) => {
        const target = document.querySelector('#target')!;
        if (change === 'remove') target.remove();
        else if (change === 'replace') {
          const next = target.cloneNode(true) as HTMLElement;
          next.textContent = 'Current';
          target.replaceWith(next);
        } else {
          const cover = target.cloneNode(true) as HTMLElement;
          cover.id = 'cover';
          cover.textContent = 'Cover';
          document.body.append(cover);
        }
      }, change);
      await clickProjected(
        viewer.frameLocator('#viewport iframe').locator('#target'),
      );
      await viewer.waitForFunction(() =>
        (window as any).targetTest.acks.some((ack: any) => !ack.ok),
      );
      const rejected = await viewer.evaluate(() => ({
        failures: (window as any).targetTest.acks.filter((ack: any) => !ack.ok),
        resyncs: (window as any).targetTest.resyncs,
        snapshots: (window as any).targetTest.snapshots,
      }));
      assert.equal(
        rejected.resyncs,
        0,
        'A moved or retired target does not invalidate the entire DOM stream',
      );
      assert.equal(
        rejected.snapshots,
        1,
        'Keep the current document and its input lifecycle',
      );
      assert.ok(
        rejected.failures.every((ack: any) => ack.code === 'target_changed'),
      );
      assert.equal(
        await viewer.locator('#toast').isVisible(),
        false,
        'Expected no-effect gesture cancellation does not interrupt browsing',
      );
      assert.equal(
        await source.evaluate(() => (window as any).clicks),
        0,
        'Never retarget or replay the click against replacement or covering content',
      );
      await viewer.mouse.move(700, 400);
      for (let i = 0; i < 12; i++) await viewer.mouse.wheel(0, 80);
      await source.waitForFunction(() => scrollY === 960);
      await viewer.evaluate(() => (window as any).targetTest.flush());
      await viewer.waitForFunction(
        () =>
          document.querySelector<HTMLIFrameElement>('#viewport iframe')!
            .contentWindow!.scrollY === 960,
      );
      if (change !== 'remove') {
        await clickProjected(
          viewer
            .frameLocator('#viewport iframe')
            .locator(change === 'cover' ? '#cover' : '#target'),
        );
        await source.waitForFunction(() => (window as any).clicks === 1);
      }
      assert.equal(
        await viewer.evaluate(() => (window as any).targetTest.resyncs),
        0,
      );
      assert.equal(await viewer.locator('#toast').isVisible(), false);
    },
  );
