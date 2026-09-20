import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

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
