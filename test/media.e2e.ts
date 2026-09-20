import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

// Generate a real WebM with video and audio in the source browser. No external site,
// codec package, microphone or display capture is needed for this regression.
for (const variant of ['blob', 'cross-origin MSE'] as const)
  test(
    `forwards ${variant} video and audio with source control and lifecycle cleanup`,
    { timeout: 60000 },
    async (t) => {
      let port = 0;
      const site = createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html');
        if (variant === 'cross-origin MSE' && req.url === '/') {
          res.end(
            `<iframe id=remote src="http://localhost:${port}/frame" width=640 height=420></iframe>`,
          );
          return;
        }
        res.end(
          '<!doctype html><title>Media fixture</title><video id="clip" controls width="320" height="180"></video><button id="play" onclick="clip.play()">Play source</button><button id="pause" onclick="clip.pause()">Pause source</button>',
        );
      });
      await new Promise<void>((resolve) => site.listen(0, resolve));
      port = (site.address() as AddressInfo).port;
      const browser = await chromium.launch({
        channel: 'chromium',
        headless: true,
        chromiumSandbox: true,
      });
      const context = await browser.newContext();
      const source = await context.newPage();
      let allowed = true;
      const service = await createProjectionServer(source, {
        authorize: () => allowed,
      });
      const client = await browser.newContext();
      const external: string[] = [];
      await client.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== new URL(service.url).origin) {
          external.push(u.origin);
          return route.abort();
        }
        return route.continue();
      });
      t.after(async () => {
        await service.close();
        await browser.close();
        await new Promise<void>((resolve) => site.close(() => resolve()));
      });
      await source.goto(
        `http://127.0.0.1:${(site.address() as AddressInfo).port}/`,
      );
      const mediaFrame =
        variant === 'blob'
          ? source.mainFrame()
          : source.frames().find((frame) => frame.url().endsWith('/frame'))!;
      await mediaFrame.evaluate(() => {
        (window as any).activeMediaPeers = 0;
        const Original = RTCPeerConnection;
        (window as any).RTCPeerConnection = class extends Original {
          constructor(configuration?: RTCConfiguration) {
            super(configuration);
            (window as any).activeMediaPeers++;
          }
          close() {
            if (this.connectionState !== 'closed')
              (window as any).activeMediaPeers--;
            super.close();
          }
        };
      });
      await mediaFrame.evaluate(async (mse) => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d')!;
        const stream = canvas.captureStream(15);
        const audio = new AudioContext();
        await audio.resume();
        const tone = audio.createOscillator();
        const out = audio.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        stream.addTrack(out.stream.getAudioTracks()[0]!);
        const recorder = new MediaRecorder(stream, {
          mimeType: 'video/webm;codecs=vp8,opus',
        });
        const parts: Blob[] = [];
        recorder.ondataavailable = (e) => parts.push(e.data);
        const done = new Promise<Blob>(
          (resolve) =>
            (recorder.onstop = () =>
              resolve(new Blob(parts, { type: recorder.mimeType }))),
        );
        let frame = 0;
        const timer = setInterval(() => {
          ctx.fillStyle = ++frame % 2 ? '#e84b4b' : '#3566df';
          ctx.fillRect(0, 0, 320, 180);
        }, 60);
        recorder.start();
        await new Promise((resolve) => setTimeout(resolve, 2200));
        recorder.stop();
        const blob = await done;
        (window as any).fixtureBlob = blob;
        clearInterval(timer);
        stream.getTracks().forEach((track) => track.stop());
        await audio.close();
        const video = document.querySelector('video')!;
        if (mse) {
          const media = new MediaSource();
          video.src = URL.createObjectURL(media);
          await new Promise<void>((resolve) =>
            media.addEventListener('sourceopen', () => resolve(), {
              once: true,
            }),
          );
          const buffer = media.addSourceBuffer('video/webm;codecs=vp8,opus');
          buffer.appendBuffer(await blob.arrayBuffer());
          await new Promise<void>((resolve) =>
            buffer.addEventListener('updateend', () => resolve(), {
              once: true,
            }),
          );
          media.endOfStream();
        } else video.src = URL.createObjectURL(blob);
        video.loop = true;
        await new Promise<void>(
          (resolve) => (video.onloadeddata = () => resolve()),
        );
      }, variant === 'cross-origin MSE');
      const viewer = await client.newPage();
      await viewer.addInitScript(() => {
        const Socket = WebSocket;
        (window as any).WebSocket = class extends Socket {
          constructor(...args: ConstructorParameters<typeof WebSocket>) {
            super(...args);
            (window as any).testSocket = this;
          }
        };
      });
      const pageErrors: string[] = [];
      viewer.on('pageerror', (error) => pageErrors.push(error.message));
      const packets: any[] = [];
      const acks: any[] = [];
      const commands: any[] = [];
      viewer.on('websocket', (ws) => {
        ws.on('framesent', (f) => {
          const m = JSON.parse(String(f.payload));
          if (m.type === 'command')
            commands.push({
              id: m.id,
              kind: m.action.kind,
              phase: m.action.phase,
            });
        });
        ws.on('framereceived', (f) => {
          const m = JSON.parse(String(f.payload));
          if (m.type === 'media')
            packets.push({ ...m.packet, data: m.packet.data?.length });
          if (m.type === 'ack') acks.push(m);
        });
      });
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const root = viewer.frameLocator('#viewport iframe').first();
      const projected =
        variant === 'blob' ? root : root.frameLocator('#remote');
      await projected.locator('#play').click();
      const decoded = async (minimumFrames = 3) => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          if (
            await projected
              .locator('#clip')
              .evaluate(
                (v: HTMLVideoElement, minimum) =>
                  v.videoWidth === 320 &&
                  v.getVideoPlaybackQuality().totalVideoFrames > minimum,
                minimumFrames,
              )
              .catch(() => false)
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        t.diagnostic(
          JSON.stringify({
            source: await mediaFrame
              .locator('#clip')
              .evaluate((v: HTMLVideoElement) => ({
                paused: v.paused,
                readyState: v.readyState,
                time: v.currentTime,
                width: v.videoWidth,
                peers: (window as any).activeMediaPeers,
              })),
            viewer: await projected
              .locator('#clip')
              .evaluate((v: HTMLVideoElement) => ({
                paused: v.paused,
                readyState: v.readyState,
                time: v.currentTime,
                width: v.videoWidth,
                frames: v.getVideoPlaybackQuality().totalVideoFrames,
                tracks: (v.srcObject as MediaStream | null)
                  ?.getTracks()
                  .map((track) => ({
                    kind: track.kind,
                    state: track.readyState,
                    muted: track.muted,
                  })),
              })),
            pageErrors,
            packets: packets.map(({ kind, stream }) => ({ kind, stream })),
            acks,
            commands,
          }),
        );
        assert.fail('Viewer must decode moving source video');
      };
      await decoded();
      assert.ok(
        packets.some((p) => p.kind === 'offer' && p.sdp.includes('m=audio')),
        'Stream must contain the source audio track',
      );
      assert.equal(
        await projected
          .locator('#clip')
          .evaluate(
            (v: HTMLVideoElement) =>
              (v.srcObject as MediaStream).getAudioTracks().length,
          ),
        1,
      );
      assert.equal(
        await projected
          .locator('#clip')
          .evaluate((v: HTMLVideoElement) => !!v.srcObject && !v.currentSrc),
        true,
      );
      assert.deepEqual(external, []);
      const previousStream = await projected
        .locator('#clip')
        .evaluate(
          (v: HTMLVideoElement) => (v.srcObject as MediaStream | null)?.id,
        );
      await mediaFrame.evaluate(async () => {
        const video = document.querySelector('video')!;
        video.src = URL.createObjectURL((window as any).fixtureBlob);
        await video.play();
      });
      const changeDeadline = Date.now() + 8000;
      while (
        (await projected
          .locator('#clip')
          .evaluate(
            (v: HTMLVideoElement) => (v.srcObject as MediaStream | null)?.id,
          )) === previousStream &&
        Date.now() < changeDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.notEqual(
        await projected
          .locator('#clip')
          .evaluate(
            (v: HTMLVideoElement) => (v.srcObject as MediaStream | null)?.id,
          ),
        previousStream,
        'Changing the source starts a fresh media stream',
      );
      await decoded();
      await projected.locator('#pause').click();
      await mediaFrame.waitForFunction(
        () => document.querySelector('video')!.paused,
      );
      const frameBefore = await viewer
        .locator('#viewport iframe')
        .elementHandle();
      const streamBefore = await projected
        .locator('#clip')
        .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).id);
      await viewer.evaluate(() =>
        (window as any).testSocket.send(JSON.stringify({ type: 'resync' })),
      );
      await viewer.waitForFunction((frame) => !frame!.isConnected, frameBefore);
      await decoded(0);
      assert.equal(
        await projected
          .locator('#clip')
          .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).id),
        streamBefore,
        'Paused frame survives replacement of the replay document',
      );
      await viewer
        .getByRole('button', { name: 'Media controls', exact: true })
        .click();
      const seek = viewer.getByRole('slider', { name: 'Seek source media' });
      await seek.fill('0.7');
      await seek.dispatchEvent('change');
      await mediaFrame.waitForFunction(
        () =>
          Math.abs(document.querySelector('video')!.currentTime - 0.7) < 0.05,
      );
      allowed = false;
      await viewer
        .getByRole('button', { name: 'Play source media', exact: true })
        .click();
      await viewer
        .getByText('The host did not authorize that action.', { exact: true })
        .waitFor();
      assert.equal(
        await mediaFrame
          .locator('video')
          .evaluate((v: HTMLVideoElement) => v.paused),
        true,
      );
      allowed = true;
      await viewer
        .getByRole('button', { name: 'Play source media', exact: true })
        .click();
      await mediaFrame.waitForFunction(
        () => !document.querySelector('video')!.paused,
      );
      await viewer.reload();
      await viewer.locator('#status.live').waitFor();
      await decoded();
      await viewer
        .getByRole('button', { name: 'New tab', exact: true })
        .click();
      await mediaFrame.waitForFunction(
        () => (window as any).activeMediaPeers === 0,
      );
      assert.equal(
        await viewer.locator('.floe-media-controls').isVisible(),
        false,
      );
      await viewer.getByRole('tab').first().click();
      await decoded();
      await mediaFrame.evaluate(async () => {
        const video = document.querySelector('video')!;
        Object.defineProperty(video, 'mediaKeys', { value: {} });
        video.src = URL.createObjectURL((window as any).fixtureBlob);
        await video.play();
      });
      await viewer
        .getByRole('button', { name: 'Media controls', exact: true })
        .click();
      await viewer
        .getByText('This media cannot play in this browser.', { exact: true })
        .waitFor();
      await mediaFrame.locator('video').evaluate((v) => v.remove());
      await viewer.locator('.floe-media-controls').waitFor({ state: 'hidden' });
      await viewer.close();
      await mediaFrame.waitForFunction(
        () => (window as any).activeMediaPeers === 0,
      );
      assert.deepEqual(external, []);
    },
  );
