import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'a track clock discontinuity cannot continually postpone an already decoded picture',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
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
      'data:text/html,<video width=160 height=90 muted></video>',
    );
    await source.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const ctx = canvas.getContext('2d')!;
      let n = 0;
      setInterval(() => {
        ctx.fillStyle = ++n % 2 ? 'red' : 'blue';
        ctx.fillRect(0, 0, 160, 90);
      }, 40);
      const audio = new AudioContext();
      const oscillator = audio.createOscillator(),
        destination = audio.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      const stream = canvas.captureStream(25);
      stream.addTrack(destination.stream.getAudioTracks()[0]!);
      const video = document.querySelector('video')!;
      video.srcObject = stream;
      await video.play();
    });
    const viewer = await browser.newPage();
    await viewer.addInitScript(() => {
      const Original = Worker;
      (window as any).Worker = class extends Original {
        postMessage(message: any, transfer: Transferable[]) {
          if (
            message.type === 'frame' &&
            message.frame.header.track === 'audio'
          )
            message.frame.header.timestamp_us += 800000;
          super.postMessage(message, transfer);
        }
      };
    });
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const root = viewer.frameLocator('#viewport iframe');
    const end = Date.now() + 4000;
    let frames = 0;
    while (Date.now() < end && frames < 15) {
      frames = await root
        .locator('video')
        .evaluate(
          (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames,
        );
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(
      frames >= 15,
      `Video presentation must keep advancing; received ${frames} pictures`,
    );
  },
);
