import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'observing stream-backed media preserves its website-owned capture through collection and disposal',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch();
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    await source.goto(
      'data:text/html,<canvas width="160" height="90"></canvas><video width="160" height="90" autoplay muted></video>',
    );
    await source.evaluate(() => {
      const canvas = document.querySelector('canvas')!,
        video = document.querySelector('video')!;
      setInterval(() => {
        const context = canvas.getContext('2d')!;
        context.fillStyle = 'lime';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 80);
      video.srcObject = canvas.captureStream(15);
      void video.play();
    });
    const viewer = await browser.newPage();
    await viewer.goto(service.url);
    await viewer.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector('video')?.videoWidth === 160,
    );
    const cdp = await source.context().newCDPSession(source);
    const assertSourceAdvances = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const before = await source
        .locator('video')
        .evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames);
      const handle = await source.waitForFunction(
        (before) =>
          document.querySelector('video')!.getVideoPlaybackQuality()
            .totalVideoFrames >
          before + 3,
        before,
        { timeout: 2000 },
      );
      await handle.dispose();
      assert.equal(
        await source
          .locator('video')
          .evaluate(
            (video) =>
              (video.srcObject as MediaStream).getVideoTracks()[0]!.readyState,
          ),
        'live',
      );
    };
    await assertSourceAdvances();
    await service.close();
    await assertSourceAdvances();
  },
);
