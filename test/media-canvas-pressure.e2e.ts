import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'video starts beside a changing Canvas after both elements are reinserted and resized',
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
      'data:text/html,<canvas id="scene" width="160" height="90"></canvas><video id="clip" width="160" height="90" autoplay muted></video>',
    );
    await source.evaluate(async () => {
      const canvas = document.querySelector('canvas')!,
        video = document.querySelector('video')!;
      setInterval(() => {
        canvas.getContext('2d')!.fillStyle = 'lime';
        canvas.getContext('2d')!.fillRect(0, 0, canvas.width, canvas.height);
      }, 80);
      video.srcObject = canvas.captureStream(15);
      await video.play();
    });
    const viewer = await browser.newPage();
    await viewer.goto(service.url);
    await viewer.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector('video')?.videoWidth === 160,
    );
    await source.evaluate(() => {
      (window as any).media = [...document.querySelectorAll('canvas,video')];
      for (const node of (window as any).media) node.remove();
    });
    await viewer.waitForFunction(
      () =>
        !document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector('video'),
    );
    await source.evaluate(async () => {
      for (const node of (window as any).media) document.body.append(node);
      const canvas = document.querySelector('canvas')!,
        video = document.querySelector('video')!;
      canvas.width = 640;
      canvas.height = 360;
      canvas.style.width = '320px';
      canvas.style.height = '180px';
      video.width = 640;
      video.height = 360;
      video.style.width = '320px';
      video.style.height = '180px';
      const context = canvas.getContext('2d')!,
        pixels = context.createImageData(640, 360);
      let seed = 0x13579;
      setInterval(() => {
        for (let i = 0; i < pixels.data.length; i += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          pixels.data[i] = seed & 255;
          pixels.data[i + 1] = (seed >>> 8) & 255;
          pixels.data[i + 2] = (seed >>> 16) & 255;
          pixels.data[i + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
      }, 33);
      await video.play();
    });
    const presented = await viewer.waitForFunction(
      () => {
        const video = document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector('video');
        if (!video?.videoWidth || video.readyState < 2) return false;
        const bounds = video.getBoundingClientRect();
        if (bounds.width !== 320 || bounds.height !== 180) return false;
        // Chromium may reduce encoded resolution to meet the 1.5 Mbit/s
        // ceiling on this noisy scene. Require current decoded pixels at the
        // source element's layout size, not an uncontracted codec resolution.
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 18;
        const context = canvas.getContext('2d')!;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, 32, 18).data;
        const red = pixels.filter((_, index) => index % 4 === 0);
        if (Math.max(...red) - Math.min(...red) < 20) return false;
        return { width: video.videoWidth, height: video.videoHeight };
      },
      undefined,
      { timeout: 10000 },
    );
    t.diagnostic(
      `Decoded noisy video: ${JSON.stringify(await presented.jsonValue())}`,
    );
    await presented.dispose();
    assert.equal(
      await source
        .locator('video')
        .evaluate(
          (video) =>
            (video.srcObject as MediaStream).getVideoTracks()[0]!.readyState,
        ),
      'live',
    );
  },
);
