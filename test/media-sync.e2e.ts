import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, firefox } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

for (const {
  videoDelay,
  audioStartupDelay,
  viewerEngine,
  retainedPictureAge = 0,
} of [
  { videoDelay: 0, audioStartupDelay: 0, viewerEngine: 'chromium' },
  { videoDelay: 0, audioStartupDelay: 0, viewerEngine: 'firefox' },
  { videoDelay: 300, audioStartupDelay: 0, viewerEngine: 'chromium' },
  { videoDelay: 300, audioStartupDelay: 180, viewerEngine: 'chromium' },
  {
    videoDelay: 0,
    audioStartupDelay: 0,
    viewerEngine: 'firefox',
    retainedPictureAge: 150,
  },
])
  test(
    `displayed video and audible pulses in ${viewerEngine} preserve source synchronization after ${videoDelay} ms of initial video loss, ${audioStartupDelay} ms audio startup and ${retainedPictureAge} ms retained picture age`,
    { timeout: 30000 },
    async (t) => {
      // Generated VP8/Opus fixture: each second starts with a simultaneous white
      // flash and tone. Measure presentation, not packet or decoder arrival time.
      const media = await readFile(
        new URL('./fixtures/av-sync.webm', import.meta.url),
      );
      const site = createServer((req, res) => {
        if (req.url === '/sync.webm') {
          res.writeHead(200, { 'Content-Type': 'video/webm' });
          res.end(media);
        } else {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            '<video id="clip" src="/sync.webm" width="160" height="90" loop playsinline></video>',
          );
        }
      });
      await new Promise<void>((resolve) =>
        site.listen(0, '127.0.0.1', resolve),
      );
      const browser = await chromium.launch({ channel: 'chromium' });
      const source = await browser.newPage();
      await source.goto(
        `http://127.0.0.1:${(site.address() as AddressInfo).port}`,
      );
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(async () => {
        await service.close();
        await browser.close();
        await new Promise<void>((resolve) => site.close(() => resolve()));
      });
      const viewerBrowser =
        viewerEngine === 'firefox' ? await firefox.launch() : browser;
      if (viewerBrowser !== browser) t.after(() => viewerBrowser.close());
      const viewer = await viewerBrowser.newPage();
      viewer.setDefaultTimeout(5000);
      await viewer.addInitScript(
        ({ videoDelay, audioStartupDelay, retainedPictureAge }) => {
          // tsx names nested callbacks before Playwright serializes this function.
          (window as any).__name = (value: unknown) => value;
          const NativeWorker = Worker;
          (window as any).Worker = class extends NativeWorker {
            private firstVideo?: number;
            postMessage(message: any, transfer: Transferable[]) {
              if (retainedPictureAge && message.type === 'frame') {
                // A retained paused picture can predate the newly flowing audio.
                // Keep timestamps positive while aging only that first picture.
                message.frame.header.timestamp_us += 1000000;
                if (
                  message.frame.header.track === 'video' &&
                  this.firstVideo === undefined
                )
                  message.frame.header.timestamp_us -=
                    retainedPictureAge * 1000;
              }
              if (
                message.type === 'frame' &&
                message.frame.header.track === 'video'
              ) {
                this.firstVideo ??= performance.now();
                if (performance.now() - this.firstVideo < videoDelay) {
                  this.dispatchEvent(
                    new MessageEvent('message', { data: { type: 'accepted' } }),
                  );
                  this.dispatchEvent(
                    new MessageEvent('message', { data: { type: 'keyframe' } }),
                  );
                  return;
                }
              }
              super.postMessage(message, transfer);
            }
          };
          const NativeAudio = AudioContext;
          (window as any).AudioContext = class extends NativeAudio {
            constructor(...args: ConstructorParameters<typeof AudioContext>) {
              const started = performance.now();
              super(...args);
              // Audio device initialization is synchronous on real browser hosts.
              // Model that startup cost without delaying any subsequent packets.
              while (performance.now() - started < audioStartupDelay) {
                /* wait */
              }
            }
          };
          const outputs = ((window as any).audioOutputs = []);
          const connect = AudioNode.prototype.connect;
          AudioNode.prototype.connect = function (...args: any[]) {
            const result = (connect as any).apply(this, args);
            if (args[0] instanceof AudioDestinationNode) {
              const analyser = this.context.createAnalyser();
              analyser.fftSize = 256;
              connect.call(this, analyser);
              outputs.push({ analyser, context: this.context });
            }
            return result;
          };
        },
        { videoDelay, audioStartupDelay, retainedPictureAge },
      );
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      await source.evaluate(() => document.querySelector('video')!.play());
      await viewer.waitForFunction(
        () => (window as any).audioOutputs.length > 0,
      );
      await viewer.locator('#address').click();
      await viewer.waitForFunction(() =>
        (window as any).audioOutputs.some(
          (output: any) => output.context.state === 'running',
        ),
      );
      const samples = await viewer.evaluate(async () => {
        const audio: number[] = [],
          video: number[] = [];
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        const pcm = new Float32Array(256);
        const start = performance.now();
        let wasBright = false,
          wasAudible = false;
        await new Promise<void>((resolve) => {
          const sample = () => {
            const now = performance.now();
            const clip = document
              .querySelector<HTMLIFrameElement>('#viewport iframe')
              ?.contentDocument?.querySelector<HTMLVideoElement>('#clip');
            let bright = false;
            if (clip && clip.readyState >= 2) {
              context.drawImage(clip, 0, 0, 1, 1);
              bright = context.getImageData(0, 0, 1, 1).data[0]! > 180;
            }
            if (bright && !wasBright) video.push(now);
            wasBright = bright;
            let audible = false;
            for (const output of (window as any).audioOutputs) {
              output.analyser.getFloatTimeDomainData(pcm);
              const first = pcm.findIndex((value) => Math.abs(value) > 0.06);
              if (first < 0) continue;
              audible = true;
              if (!wasAudible) {
                const clock = output.context.getOutputTimestamp();
                const outputAt =
                  clock.performanceTime +
                  (output.context.currentTime -
                    (pcm.length - first) / output.context.sampleRate -
                    clock.contextTime) *
                    1000;
                // Ringing or a render gap within one 100 ms tone is not a new
                // pulse. Compare the first onset of each one-second cycle.
                if (!audio.length || outputAt - audio.at(-1)! > 500)
                  audio.push(outputAt);
              }
              break;
            }
            wasAudible = audible;
            if (now - start >= 12000) resolve();
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        return { audio, video, start, end: performance.now() };
      });
      // Retain evidence even when a pulse-count assertion fails before skew
      // calculation, including whether native source playback itself stopped.
      const sourceState = await source.evaluate(() => {
        const clip = document.querySelector('video')!;
        return {
          paused: clip.paused,
          currentTime: clip.currentTime,
          readyState: clip.readyState,
        };
      });
      t.diagnostic(JSON.stringify({ samples, sourceState }));
      assert.ok(
        samples.audio.length >= 8,
        'Audible pulses reach the actual output graph',
      );
      assert.ok(
        samples.video.length >= 8,
        'Decoded flashes appear in the displayed video',
      );
      // Capture both edges outside the comparison window too: an audio edge just
      // before warmup ends still belongs to the same displayed flash afterward.
      const measuredVideo = samples.video.filter(
        (at) => at >= samples.start + 2000 && at < samples.end - 500,
      );
      assert.ok(
        measuredVideo.length >= 8,
        'At least eight complete pulse pairs are measured',
      );
      const skew = measuredVideo.map((at) =>
        Math.min(...samples.audio.map((value) => Math.abs(value - at))),
      );
      t.diagnostic(JSON.stringify({ ...samples, skew }));
      assert.ok(
        Math.max(...skew) <= 100,
        `Presented audio/video skew ${Math.max(...skew).toFixed(1)} ms exceeds 100 ms`,
      );
    },
  );
