import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

for (const engine of [chromium, firefox])
  test(`Opus decoding in ${engine.name()} preserves packet gaps and source clock corrections`, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const worker = await readFile('dist/assets/media-worker.js', 'utf8');
    await page.route('http://127.0.0.1/**', (route) =>
      route.fulfill({
        contentType: route.request().url().endsWith('worker.js')
          ? 'text/javascript'
          : 'text/html',
        body: route.request().url().endsWith('worker.js')
          ? worker
          : '<!doctype html><title>Audio packet clock</title>',
      }),
    );
    await page.goto('http://127.0.0.1/');
    const timestamps = [1000000, 1020000, 1420000, 1437500, 1457500];
    const result = await page.evaluate(async (timestamps) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      const result: { timestamp: number; frames: number }[] = [];
      try {
        for (const timestamp of timestamps) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Opus output timed out')),
              4000,
            );
            worker.onerror = (event) => reject(new Error(event.message));
            worker.onmessage = ({ data }) => {
              if (data.type === 'unavailable')
                reject(new Error('Opus decoding unavailable'));
              if (data.type !== 'audio') return;
              clearTimeout(timer);
              const frames = data.channels[0].length;
              result.push({ timestamp: data.timestamp, frames });
              worker.postMessage({ type: 'audio-consumed', frames });
              resolve();
            };
            // RFC 7587's 20 ms Opus silence packet remains independently decodable.
            worker.postMessage({
              type: 'frame',
              frame: {
                header: {
                  version: 1,
                  target: 't',
                  view: 'v',
                  stream: 's',
                  node: 1,
                  track: 'audio',
                  codec: 'opus',
                  timestamp_us: timestamp,
                  duration_us: 20000,
                  keyframe: true,
                  bytes: 3,
                },
                data: new Uint8Array([0xf8, 0xff, 0xfe]),
              },
            });
          });
        }
        return result;
      } finally {
        worker.terminate();
      }
    }, timestamps);
    assert.deepEqual(
      result.map((item) => item.frames),
      timestamps.map(() => 960),
    );
    assert.deepEqual(
      result.map((item) => item.timestamp),
      timestamps,
    );
  });
