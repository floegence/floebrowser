import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

async function setup(page: Page, prefix = '') {
  page.setDefaultTimeout(4000);
  const code = await readFile('dist/assets/media-worker.js', 'utf8');
  await page.route('http://127.0.0.1/decoder', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Decoder qualification</title>',
    }),
  );
  await page.route('http://127.0.0.1/worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: prefix + '\n' + code,
    }),
  );
  await page.goto('http://127.0.0.1/decoder');
  await page.evaluate(async () => {
    const state = window as any;
    state.events = [];
    state.errors = [];
    const worker = (state.worker = new Worker('/worker.js', {
      type: 'module',
    }));
    worker.onerror = (event: ErrorEvent) => state.errors.push(event.message);
    worker.onmessage = ({ data }: MessageEvent) => {
      state.events.push({ type: data.type, track: data.track });
      if (data.type === 'video') {
        data.frame.close();
        worker.postMessage({ type: 'painted' });
      }
      if (data.type === 'audio')
        worker.postMessage({
          type: 'audio-consumed',
          frames: data.channels[0].length,
        });
    };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
    const encoder = new VideoEncoder({
      output(chunk) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        state.video = bytes;
      },
      error(error) {
        throw error;
      },
    });
    encoder.configure({ codec: 'vp8', width: 16, height: 16, bitrate: 100000 });
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
    encoder.close();
    const audio = new AudioEncoder({
      output(chunk) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        state.audio = bytes;
      },
      error(error) {
        throw error;
      },
    });
    audio.configure({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 64000,
    });
    const samples = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfChannels: 2,
      numberOfFrames: 960,
      timestamp: 0,
      data: new Float32Array(1920),
    });
    audio.encode(samples);
    samples.close();
    await audio.flush();
    audio.close();
    state.send = (track: 'audio' | 'video', valid = true) => {
      const bytes =
        track === 'video'
          ? valid
            ? state.video
            : state.video.slice(0, 12)
          : state.audio;
      worker.postMessage({
        type: 'frame',
        frame: {
          header: {
            version: 1,
            target: 'source',
            view: 'view',
            stream: 'stream',
            node: 1,
            track,
            codec: track === 'video' ? 'vp8' : 'opus',
            timestamp_us: 0,
            duration_us: 20000,
            keyframe: true,
            ...(track === 'video' ? { width: 16, height: 16 } : {}),
            bytes: bytes.length,
          },
          data: bytes,
        },
      });
    };
  });
}

test('missing audio decoding is reported once while the video track continues', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await setup(page, 'globalThis.AudioDecoder=undefined;');
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) (window as any).send('audio');
    (window as any).send('video');
  });
  await page.waitForFunction(() =>
    (window as any).events.some((e: any) => e.type === 'video'),
  );
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).events.filter(
          (e: any) => e.type === 'unavailable' && e.track === 'audio',
        ).length,
    ),
    1,
  );
  assert.deepEqual(await page.evaluate(() => (window as any).errors), []);
});

test('missing video decoding leaves source audio playable', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await setup(page, 'globalThis.VideoDecoder=undefined;');
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) (window as any).send('video');
    (window as any).send('audio');
  });
  await page.waitForFunction(() =>
    (window as any).events.some((e: any) => e.type === 'audio'),
  );
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).events.filter(
          (e: any) => e.type === 'unavailable' && e.track === 'video',
        ).length,
    ),
    1,
  );
  assert.deepEqual(await page.evaluate(() => (window as any).errors), []);
});

test('asynchronous video decoder failure closes safely and recovers at a fresh keyframe', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await setup(page);
  await page.evaluate(() => (window as any).send('video', false));
  await page.waitForFunction(
    () =>
      (window as any).events.some((e: any) => e.type === 'keyframe') ||
      (window as any).errors.length,
  );
  assert.deepEqual(
    await page.evaluate(() => (window as any).errors),
    [],
    'A closed WebCodecs decoder must not be closed again from its error callback',
  );
  await page.evaluate(() => (window as any).send('video'));
  await page.waitForFunction(() =>
    (window as any).events.some((e: any) => e.type === 'video'),
  );
  assert.equal(
    await page.evaluate(() =>
      (window as any).events.some((e: any) => e.type === 'unavailable'),
    ),
    false,
  );
});

test('repeated broken video ends only that track without endless keyframe requests', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await setup(page);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as any).send('video', false));
    await page.waitForFunction(
      (count) =>
        (window as any).events.filter(
          (e: any) => e.type === 'keyframe' || e.type === 'unavailable',
        ).length >= count,
      i + 1,
    );
  }
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).events.filter((e: any) => e.type === 'unavailable')
          .length,
    ),
    1,
  );
  const count = await page.evaluate(() => (window as any).events.length);
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) (window as any).send('video', false);
  });
  await page.waitForFunction(
    (count) => (window as any).events.length >= count + 20,
    count,
  );
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).events.filter((e: any) => e.type === 'keyframe').length,
    ),
    2,
  );
  assert.deepEqual(await page.evaluate(() => (window as any).errors), []);
  await page.evaluate(() => (window as any).send('audio'));
  await page.waitForFunction(() =>
    (window as any).events.some((e: any) => e.type === 'audio'),
  );
});

test('successful video decoding renews the bounded recovery budget', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await setup(page);
  for (let i = 1; i <= 5; i++) {
    await page.evaluate(() => (window as any).send('video', false));
    await page.waitForFunction(
      (n) =>
        (window as any).events.filter((e: any) => e.type === 'keyframe')
          .length === n,
      i,
    );
    await page.evaluate(() => (window as any).send('video'));
    await page.waitForFunction(
      (n) =>
        (window as any).events.filter((e: any) => e.type === 'video').length ===
        n,
      i,
    );
  }
  assert.equal(
    await page.evaluate(() =>
      (window as any).events.some((e: any) => e.type === 'unavailable'),
    ),
    false,
  );
  assert.deepEqual(await page.evaluate(() => (window as any).errors), []);
});
