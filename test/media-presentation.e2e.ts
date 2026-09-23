import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

for (const engine of [chromium, firefox])
  test(`future pictures retain their presentation deadlines in ${engine.name()}`, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route('http://127.0.0.1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill(
        path === '/'
          ? { contentType: 'text/html', body: '<video></video>' }
          : {
              contentType: 'text/javascript',
              body: await readFile(new URL(`..${path}`, import.meta.url)),
            },
      );
    });
    await page.goto('http://127.0.0.1/');
    const result = await page.evaluate(async () => {
      (window as any).__name = (value: unknown) => value;
      const { MediaView } = await import('/dist/viewer/media.js');
      const view = new MediaView(
        undefined,
        () => document.querySelector('video'),
        async () => true,
        () => {},
      );
      view.receive(
        {
          kind: 'state',
          id: 1,
          stream: 's',
          paused: true,
          muted: true,
          volume: 1,
          time: 0,
          duration: 1,
          status: 'streaming',
          reason: '',
        },
        { target: 't', view: 'v' },
      );
      const playback = view.playback.get('t:s');
      let now = 1000;
      const originalNow = performance.now.bind(performance);
      performance.now = () => now;
      let next = 0;
      const callbacks = new Map<number, FrameRequestCallback>();
      const request = requestAnimationFrame,
        cancel = cancelAnimationFrame;
      window.requestAnimationFrame = (callback) => {
        callbacks.set(++next, callback);
        return next;
      };
      window.cancelAnimationFrame = (id) => {
        callbacks.delete(id);
      };
      let consumed = 0;
      playback.decoder = {
        painted: () => consumed++,
        close() {},
        resetVideo() {},
      };
      playback.clock = { timestamp: 0, at: 1150 };
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const context = canvas.getContext('2d')!;
      const frames: VideoFrame[] = [];
      const presented: { at: number; white: boolean }[] = [];
      const tick = (at: number) => {
        now = at;
        const batch = [...callbacks.values()];
        callbacks.clear();
        batch.forEach((callback) => callback(now));
        if (playback.paint) {
          const pixel = playback.paint.getContext('2d').getImageData(0, 0, 1, 1)
            .data[0];
          presented.push({ at, white: pixel > 180 });
        }
      };
      try {
        // A decoder can run ahead of the shared presentation clock. The short
        // white picture must survive even though later black pictures arrive.
        for (let i = 0; i < 6; i++) {
          context.fillStyle = i === 2 ? 'white' : 'black';
          context.fillRect(0, 0, 8, 8);
          const frame = new VideoFrame(canvas, { timestamp: i * 42000 });
          frames.push(frame);
          view.decoded(playback, { type: 'video', frame });
        }
        tick(1100);
        const early = presented.length;
        for (const at of [1150, 1192, 1234, 1276, 1318, 1360]) tick(at);
        const acknowledged = consumed;
        const allClosed = frames.every((frame) => frame.codedWidth === 0);
        const future = new VideoFrame(canvas, { timestamp: 300000 });
        view.decoded(playback, { type: 'video', frame: future });
        view.select('t');
        const clearedOnSelect = future.codedWidth === 0 && callbacks.size === 0;
        view.destroy();
        return { early, presented, acknowledged, allClosed, clearedOnSelect };
      } finally {
        view.destroy();
        performance.now = originalNow;
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
      }
    });
    assert.equal(
      result.early,
      0,
      'No picture may be presented before its deadline',
    );
    assert.deepEqual(
      result.presented,
      [1150, 1192, 1234, 1276, 1318, 1360].map((at) => ({
        at,
        white: at === 1234,
      })),
    );
    assert.equal(
      result.acknowledged,
      6,
      'Each consumed picture returns one decoder credit',
    );
    assert.equal(result.allClosed, true);
    assert.equal(
      result.clearedOnSelect,
      true,
      'Selection clears queued pictures before requesting a fresh keyframe',
    );
  });
