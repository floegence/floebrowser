import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { BrowserProjection } from '../dist/host/engine.js';
import { NativeMediaBridge } from '../dist/host/media-bridge.js';
import { mediaExecutable } from '../dist/host/media-executable.js';
import type { ServerMessage } from '../src/shared/protocol.js';

const wait = async (condition: () => boolean) => {
  const end = Date.now() + 6000;
  while (!condition() && Date.now() < end)
    await new Promise((done) => setTimeout(done, 20));
  assert.ok(condition(), 'Expected background media state was not reached');
};

test(
  'hiding an authorized observation stops pictures and DOM while audio and source playback continue',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const bridge = new NativeMediaBridge(mediaExecutable());
    const source = await (await browser.newContext()).newPage();
    t.after(async () => {
      await bridge.close();
      await browser.close();
    });
    await source.goto(
      'data:text/html,<title>Background source</title><video width=160 height=90 muted></video><output>0</output>',
    );
    await source.evaluate(async () => {
      const Original = RTCPeerConnection;
      (window as any).capturePeers = [];
      (window as any).RTCPeerConnection = class extends Original {
        constructor(options?: RTCConfiguration) {
          super(options);
          (window as any).capturePeers.push(this);
        }
      };
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const ctx = canvas.getContext('2d')!;
      let n = 0;
      setInterval(() => {
        ctx.fillStyle = ++n % 2 ? 'red' : 'blue';
        ctx.fillRect(0, 0, 160, 90);
        document.querySelector('output')!.textContent = String(n);
      }, 40);
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      await audio.resume();
      const video = document.querySelector('video')!;
      video.srcObject = new MediaStream([
        ...canvas.captureStream(25).getTracks(),
        ...destination.stream.getTracks(),
      ]);
      await video.play();
    });
    let collectors = 0,
      audio = 0,
      video = 0;
    const engine = await BrowserProjection.attach(source, {
      authorize: () => true,
      mediaBridge: {
        close: () => bridge.close(),
        open: (...args) => {
          collectors++;
          return bridge.open(...args);
        },
      },
    });
    t.after(() => engine.close());
    const messages: ServerMessage[] = [];
    const observation = await engine.observe(
      (message) => messages.push(message),
      {
        onMediaFrame: (frame) => {
          if (frame.header.track === 'audio') audio++;
          if (frame.header.track === 'video') video++;
        },
      },
    );
    await wait(() => audio > 3 && video > 3);
    const streams = collectors;
    await observation.setVisible(false);
    await source.waitForFunction(() =>
      (window as any).capturePeers.some((peer: RTCPeerConnection) =>
        peer
          .getSenders()
          .some(
            (sender) =>
              sender.track?.kind === 'video' &&
              sender
                .getParameters()
                .encodings.every((encoding) => encoding.active === false),
          ),
      ),
    );
    const audioBefore = audio,
      videoBefore = video;
    const domBefore = messages.filter(
      (message) => message.type === 'events' || message.type === 'snapshot',
    ).length;
    await wait(() => audio > audioBefore + 15);
    assert.equal(
      video,
      videoBefore,
      'Hidden observers receive no video frames',
    );
    assert.equal(
      messages.filter(
        (message) => message.type === 'events' || message.type === 'snapshot',
      ).length,
      domBefore,
      'Background DOM must not occupy the host carrier',
    );
    assert.equal(
      await source
        .locator('video')
        .evaluate((element: HTMLVideoElement) => element.paused),
      false,
    );
    assert.equal(
      collectors,
      streams,
      'Visibility changes do not interrupt the audio collector',
    );
    await observation.setVisible(true);
    await wait(() => video > videoBefore + 3);
    assert.equal(collectors, streams);
    await observation.close();
    const audioStopped = audio;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(
      audio,
      audioStopped,
      'Revocation stops background audio immediately',
    );
  },
);

test(
  'the browser retains decoded background audio and locates its originating tab',
  { timeout: 20000 },
  async (t) => {
    const { createProjectionServer } = await import('../dist/host/server.js');
    const browser = await chromium.launch({
      channel: 'chromium',
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const source = await (await browser.newContext()).newPage();
    const actions: string[] = [];
    const service = await createProjectionServer(source, {
      authorize: (action) => {
        actions.push(
          action.kind === 'media' ? `media:${action.operation}` : action.kind,
        );
        return true;
      },
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    await source.goto(
      'data:text/html,<title>Music source</title><video width=160 height=90></video>',
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
      const oscillator = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      await audio.resume();
      const video = document.querySelector('video')!;
      video.srcObject = new MediaStream([
        ...canvas.captureStream(25).getTracks(),
        ...destination.stream.getTracks(),
      ]);
      await video.play();
    });
    const target = service.engine.id;
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(5000);
    await viewer.addInitScript(() => {
      (window as any).decodedAudio = {};
      const Original = Worker;
      (window as any).Worker = class extends Original {
        target = '';
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (
              data.type === 'audio' &&
              data.channels.some((channel: Float32Array) =>
                channel.some((sample) => Math.abs(sample) > 0.001),
              )
            )
              (window as any).decodedAudio[this.target] =
                ((window as any).decodedAudio[this.target] ?? 0) + 1;
          });
        }
        postMessage(data: any, transfer: any) {
          if (data.type === 'frame') this.target = data.frame.header.target;
          super.postMessage(data, transfer);
        }
      };
    });
    await viewer.goto(service.url);
    await viewer.waitForFunction(
      (target) => (window as any).decodedAudio[target] > 5,
      target,
    );
    await viewer.locator('#new-tab').click();
    await viewer.waitForFunction(
      () =>
        document.querySelector('.tab-select[aria-selected="true"]')
          ?.textContent === 'New tab',
    );
    await viewer.locator('#status.live').waitFor();
    const before = await viewer.evaluate(
      (target) => (window as any).decodedAudio[target],
      target,
    );
    await viewer.waitForFunction(
      ({ target, before }) =>
        (window as any).decodedAudio[target] > before + 15,
      { target, before },
    );
    assert.equal(
      await source
        .locator('video')
        .evaluate((video: HTMLVideoElement) => video.paused),
      false,
    );
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .click();
    const row = viewer
      .locator('.floe-media-row')
      .filter({ hasText: 'Music source' });
    await row.getByRole('button', { name: 'Open tab', exact: true }).click();
    await viewer.frameLocator('#viewport iframe').locator('video').waitFor();
    await viewer.waitForFunction(
      () =>
        document.querySelector('.tab-select[aria-selected="true"]')
          ?.textContent === 'Music source',
    );
    assert.equal(
      actions.includes('media:play'),
      false,
      'Opening a background media source does not invoke playback',
    );
    await viewer.locator('#new-tab').click();
    await viewer.waitForFunction(
      () =>
        document.querySelector('.tab-select[aria-selected="true"]')
          ?.textContent === 'New tab',
    );
    await viewer.locator('#status.live').waitFor();
    await viewer
      .locator('.tab')
      .filter({ hasText: 'Music source' })
      .getByRole('button', { name: 'Close Music source', exact: true })
      .click();
    await viewer.waitForFunction(
      () => !document.querySelector('.tab-select[title^="Music source"]'),
    );
    await new Promise((done) => setTimeout(done, 300));
    const stopped = await viewer.evaluate(
      (target) => (window as any).decodedAudio[target],
      target,
    );
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(
      await viewer.evaluate(
        (target) => (window as any).decodedAudio[target],
        target,
      ),
      stopped,
      'Closing the originating page retires its decoder',
    );
  },
);
