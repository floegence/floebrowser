import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';

test(
  'decoded PCM reaches AudioWorklet output and mute takes effect without source playback',
  { timeout: 15000 },
  async (t) => {
    const files: Record<string, string> = {
      '/audio.js': 'dist/viewer/audio-output.js',
      '/worklet.js': 'dist/assets/audio-worklet.js',
    };
    const server = createServer((req, res) => {
      const path = files[req.url ?? ''];
      if (!path) {
        res.end('<button id=start>Enable audio</button>');
        return;
      }
      void readFile(path).then((bytes) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(bytes);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const browser = await chromium.launch({
      channel: 'chromium',
      chromiumSandbox: true,
    });
    t.after(async () => {
      await browser.close();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    await page.evaluate(async () => {
      const Original = AudioContext;
      let analyser: AnalyserNode;
      (window as any).AudioContext = class extends Original {
        createGain() {
          const gain = super.createGain();
          analyser = this.createAnalyser();
          analyser.fftSize = 256;
          const silent = super.createGain();
          silent.gain.value = 0;
          gain.connect(analyser).connect(silent).connect(this.destination);
          return gain;
        }
      };
      const { AudioOutput } = await import('/audio.js');
      const output = new AudioOutput('/worklet.js', () => {});
      (window as any).output = output;
      (window as any).consumed = 0;
      await output.add('track', (frames: number) => {
        (window as any).consumed += frames;
      });
      document.querySelector<HTMLButtonElement>('#start')!.onclick = () =>
        void output.unlock();
      (window as any).energy = () => {
        const samples = new Float32Array(256);
        analyser.getFloatTimeDomainData(samples);
        return Math.max(...samples.map((v) => Math.abs(v)));
      };
      (window as any).feed = () => {
        output.push(
          'track',
          [
            new Float32Array(4800).fill(0.25),
            new Float32Array(4800).fill(0.25),
          ],
          30,
        );
      };
    });
    await page.locator('#start').click();
    await page.waitForFunction(() => (window as any).output.running);
    await page.evaluate(() => {
      (window as any).output.volume('track', 1);
      (window as any).feed();
    });
    await page.waitForFunction(() => (window as any).energy() > 0.2);
    await page.waitForFunction(() => (window as any).consumed >= 4800);
    await page.evaluate(() => {
      (window as any).output.volume('track', 0);
      (window as any).feed();
    });
    await page.waitForFunction(() => (window as any).consumed >= 9600);
    assert.ok(
      await page.evaluate(() => (window as any).energy() < 0.001),
      'Mute silences actual worklet output',
    );
    await page.evaluate(() => {
      (window as any).output.close();
    });
  },
);
