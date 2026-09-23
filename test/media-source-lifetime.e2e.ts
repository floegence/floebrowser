import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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

test(
  'file-backed audio owns and releases only its projection tracks',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch({ channel: 'chromium' });
    t.after(() => browser.close());
    const source = await browser.newPage();
    source.setDefaultTimeout(4000);
    source.on('pageerror', (error) => t.diagnostic(`source: ${error.message}`));
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const fixture = await readFile(
      new URL('./fixtures/av-sync.webm', import.meta.url),
    );
    await source.route('http://127.0.0.1/lifetime**', (route) =>
      route.fulfill(
        route.request().url().endsWith('.webm')
          ? { contentType: 'video/webm', body: fixture }
          : {
              contentType: 'text/html',
              body: '<video src="/lifetime.webm" loop></video>',
            },
      ),
    );
    await source.addInitScript(() => {
      const state = window as any;
      state.__name = (value: unknown) => value;
      state.ownedAudio = [];
      const Processor = state.MediaStreamTrackProcessor;
      const Generator = state.MediaStreamTrackGenerator;
      state.MediaStreamTrackProcessor = class extends Processor {
        constructor(options: any) {
          super(options);
          state.ownedAudio.push(options.track);
        }
      };
      state.MediaStreamTrackGenerator = class extends Generator {
        constructor(options: any) {
          super(options);
          state.ownedAudio.push(this);
        }
      };
    });
    await source.goto('http://127.0.0.1/lifetime');
    await source.locator('video').evaluate(async (video) => {
      video.volume = 0.3;
      video.playbackRate = 1.25;
      await video.play();
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(4000);
    await viewer.goto(service.url);
    await viewer
      .waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>('#viewport iframe')
            ?.contentDocument?.querySelector('video')?.videoWidth === 320,
      )
      .catch(async (error) => {
        t.diagnostic(
          JSON.stringify(
            await source.evaluate(() => ({
              tracks: (window as any).ownedAudio.map(
                (track: MediaStreamTrack) => ({
                  kind: track.kind,
                  state: track.readyState,
                }),
              ),
              video: document.querySelector('video')!.readyState,
            })),
          ),
        );
        t.diagnostic(await viewer.locator('body').innerText());
        throw error;
      });
    assert.equal(
      await source.evaluate(() => (window as any).ownedAudio.length),
      2,
    );
    await service.close();
    await source.waitForFunction(() =>
      (window as any).ownedAudio.every(
        (track: MediaStreamTrack) => track.readyState === 'ended',
      ),
    );
    const state = await source.locator('video').evaluate((video) => ({
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      rate: video.playbackRate,
      time: video.currentTime,
    }));
    assert.equal(state.paused, false);
    assert.equal(state.muted, false);
    assert.equal(state.volume, 0.3);
    assert.equal(state.rate, 1.25);
    await source.waitForFunction(
      (time) => document.querySelector('video')!.currentTime > time + 0.1,
      state.time,
    );
  },
);
