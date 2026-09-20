import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'a new controlling window can hover and click source video without stale-view errors',
  { timeout: 30000 },
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
      'data:text/html,<video width="320" height="180" muted></video>',
    );
    await source.evaluate(async () => {
      (window as any).clicks = 0;
      (window as any).moves = 0;
      const video = document.querySelector('video')!;
      video.onclick = () => {
        (window as any).clicks++;
      };
      video.onmousemove = () => {
        (window as any).moves++;
      };
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      setInterval(() => {
        ctx.fillStyle = 'blue';
        ctx.fillRect(0, 0, 320, 180);
      }, 40);
      video.srcObject = canvas.captureStream(25);
      await video.play();
    });
    const first = await browser.newPage();
    await first.goto(service.url);
    await first.locator('#status.live').waitFor();
    const next = await browser.newPage();
    const acknowledgements: any[] = [];
    next.on('websocket', (socket) =>
      socket.on('framereceived', (event) => {
        const message = JSON.parse(String(event.payload));
        if (message.type === 'ack') acknowledgements.push(message);
      }),
    );
    await next.goto(service.url);
    await next
      .getByRole('button', { name: 'Use in this window', exact: true })
      .click();
    await next.locator('#status.live').waitFor();
    await first.locator('#status.disconnected').waitFor();
    const video = next.frameLocator('#viewport iframe').locator('video');
    await video.hover();
    await video.click();
    const deadline = Date.now() + 3000;
    while (acknowledgements.length < 3 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      acknowledgements.length >= 3,
      'Hover and click receive source acknowledgements',
    );
    assert.deepEqual(
      acknowledgements.filter((a) => !a.ok),
      [],
      'A supported video element must accept source pointer input',
    );
    // The browser may emit multiple hover moves before down/up complete.
    await source.waitForFunction(() => (window as any).clicks === 1);
    const effects = await source.evaluate(() => ({
      clicks: (window as any).clicks,
      moves: (window as any).moves,
    }));
    assert.equal(effects.clicks, 1);
    assert.ok(effects.moves > 0);
    assert.equal(
      await next
        .getByText(
          'The page changed before that action. Please try again on the current view.',
          { exact: true },
        )
        .isVisible(),
      false,
    );
  },
);
