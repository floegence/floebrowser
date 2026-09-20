import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

for (const confirmation of ['rejected', 'expired'] as const)
  for (const failure of ['hover', 'old document', 'current click'] as const)
    test(
      `input failure feedback distinguishes ${failure}: ${confirmation}`,
      { timeout: 15000 },
      async (t) => {
        const browser = await chromium.launch({ chromiumSandbox: true });
        const source = await browser.newPage();
        await source.goto(
          'data:text/html,<button id="target" onclick="window.clicks++">Original</button><script>window.clicks=0</script>',
        );
        const service = await createProjectionServer(source, {
          authorize: () => true,
        });
        const viewer = await browser.newPage();
        viewer.setDefaultTimeout(4000);
        if (confirmation === 'expired')
          await viewer.addInitScript(() => {
            const original = window.setTimeout;
            window.setTimeout = ((
              handler: TimerHandler,
              delay?: number,
              ...args: any[]
            ) => {
              if (delay !== 25000) return original(handler, delay, ...args);
              return original(() => {
                if (typeof handler === 'function') handler(...args);
                (window as any).actionExpired = true;
              }, 1200);
            }) as typeof setTimeout;
          });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        t.after(async () => {
          release();
          await browser.close();
          await service.close();
        });
        const acks: any[] = [];
        viewer.on('websocket', (socket) =>
          socket.on('framereceived', ({ payload }) => {
            const message = JSON.parse(String(payload));
            if (message.type === 'ack') acks.push(message);
          }),
        );
        await viewer.goto(service.url);
        await viewer.locator('#status.live').waitFor();
        const cdp = (service.engine as any).cdp;
        const send = cdp.send.bind(cdp);
        let injected = false;
        let completed!: () => void;
        const failed = new Promise<void>((resolve) => {
          completed = resolve;
        });
        let clicks = 0;
        cdp.send = async (method: string, params: any) => {
          if (
            !injected &&
            method === 'Input.dispatchMouseEvent' &&
            params.type ===
              (failure === 'hover' ? 'mouseMoved' : 'mouseReleased')
          ) {
            injected = true;
            if (failure === 'old document') {
              await send(method, params);
              clicks = await source.evaluate(() => (window as any).clicks);
              await source.goto(
                'data:text/html,<h1 id="current">Current document</h1>',
              );
              await viewer
                .frameLocator('#viewport iframe')
                .locator('#current')
                .waitFor();
            }
            completed();
            if (confirmation === 'expired') await gate;
            throw new Error('Injected input acknowledgement failure');
          }
          return send(method, params);
        };
        const target = viewer
          .frameLocator('#viewport iframe')
          .locator('#target');
        if (failure === 'hover') await target.hover();
        else await target.click();
        await failed;
        if (confirmation === 'expired') {
          await viewer.waitForFunction(() => (window as any).actionExpired);
          assert.equal(
            await viewer.locator('#toast').isVisible(),
            failure === 'current click',
          );
          release();
        }
        for (
          let attempt = 0;
          attempt < 100 && !acks.some((ack) => !ack.ok);
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(
          acks.some((ack) => !ack.ok),
          'The source must still reject unconfirmed actions',
        );
        assert.equal(
          await viewer.locator('#toast').isVisible(),
          failure === 'current click',
          'Only a failed action in the current document needs user-facing feedback',
        );
        assert.equal(
          await viewer.locator('#connection-overlay').isVisible(),
          false,
        );
        if (failure === 'old document')
          assert.equal(
            clicks,
            1,
            'An uncertain completed click must not be replayed',
          );
      },
    );

test(
  'stale hover is quiet and a rejected click refreshes the view without replaying input',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    const source = await browser.newPage();
    await source.goto(
      'data:text/html,<button id="target" onclick="window.clicks++">Original</button><script>window.clicks=0</script>',
    );
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const viewer = await browser.newPage();
    await viewer.addInitScript(() => {
      const state = ((window as any).testCarrier = {
        holdDOM: false,
        acks: [],
        snapshots: 0,
        resyncs: 0,
        refreshNonblocking: false,
      });
      const Socket = WebSocket;
      (window as any).WebSocket = class extends Socket {
        send(data: string) {
          if (JSON.parse(data).type === 'resync') {
            state.resyncs++;
            state.refreshNonblocking =
              document
                .querySelector('#status')!
                .classList.contains('refreshing') &&
              (document.querySelector('#connection-overlay') as HTMLElement)
                .hidden &&
              !(document.querySelector('#address') as HTMLInputElement)
                .disabled;
          }
          super.send(data);
        }
        addEventListener(type: string, listener: any, options?: any) {
          if (type !== 'message')
            return super.addEventListener(type, listener, options);
          super.addEventListener(
            type,
            (event: MessageEvent) => {
              const message = JSON.parse(event.data);
              if (message.type === 'snapshot') {
                state.snapshots++;
                state.holdDOM = false;
              }
              if (message.type === 'ack') state.acks.push(message);
              // Represent a client whose incremental DOM has fallen behind the source.
              if (message.type === 'events' && state.holdDOM) return;
              listener(event);
            },
            options,
          );
        }
      };
    });
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await viewer.evaluate(() => ((window as any).testCarrier.holdDOM = true));
    await source.evaluate(() => {
      const old = document.querySelector('button')!;
      const next = old.cloneNode(true) as HTMLButtonElement;
      next.textContent = 'Current';
      old.replaceWith(next);
    });
    const button = viewer.frameLocator('#viewport iframe').locator('#target');
    await button.hover();
    await viewer.waitForFunction(() =>
      (window as any).testCarrier.acks.some(
        (a: any) => a.code === 'stale_view',
      ),
    );
    assert.equal(
      await viewer
        .getByText(
          'The page changed before that action. Please try again on the current view.',
          { exact: true },
        )
        .isVisible(),
      false,
      'Passive hover does not produce an action failure toast',
    );
    assert.equal(
      await button.textContent(),
      'Original',
      'The fixture still shows the old target',
    );
    await button.click();
    await viewer.waitForFunction(
      () => (window as any).testCarrier.snapshots === 2,
      null,
      { timeout: 3000 },
    );
    await viewer.locator('#status.live').waitFor();
    assert.equal(await button.textContent(), 'Current');
    assert.equal(
      await viewer.evaluate(() => (window as any).testCarrier.resyncs),
      1,
      'Down/up rejection requests one fresh view',
    );
    assert.equal(
      await viewer.evaluate(
        () => (window as any).testCarrier.refreshNonblocking,
      ),
      true,
      'Refreshing a view keeps its content and navigation visible without a connection overlay',
    );
    assert.equal(
      await source.evaluate(() => (window as any).clicks),
      0,
      'A rejected click must never be retried against the replacement',
    );
    await button.click();
    await source.waitForFunction(() => (window as any).clicks === 1);
  },
);
