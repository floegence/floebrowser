import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'hidden unavailable media does not cover a page or force open controls',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    const source = await browser.newPage();
    await source.goto(
      'data:text/html,' +
        encodeURIComponent(
          `<!doctype html><style>body{height:2000px}video{display:none}button{position:fixed;bottom:20px;right:20px}</style><video></video><video></video><button onclick="this.textContent='Clicked'">Page action</button>`,
        ),
    );
    await source.evaluate(() => {
      for (const video of document.querySelectorAll('video')) {
        Object.defineProperty(video, 'readyState', { value: 2 });
        (video as any).captureStream = () => {
          throw new DOMException('Cross-origin media', 'SecurityError');
        };
      }
    });
    const states: any[] = [];
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const viewer = await browser.newPage();
    viewer.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === 'media' && message.packet.kind === 'state')
          states.push(message.packet);
      }),
    );
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await viewer
      .frameLocator('#viewport iframe')
      .getByRole('button', { name: 'Page action' })
      .click();
    await source.getByText('Clicked', { exact: true }).waitFor();
    assert.equal(
      states.filter((s) => s.status === 'unavailable').length,
      2,
      'The fixture reproduces both capture failures',
    );
    assert.equal(
      await viewer.locator('#viewport .floe-media-dock').count(),
      0,
      'Media diagnostics must not float over website content',
    );
    assert.equal(
      await viewer
        .getByRole('button', { name: 'Media controls', exact: true })
        .isVisible(),
      false,
      'Hidden idle media does not need browser controls',
    );
    assert.equal(
      await viewer
        .getByRole('dialog', { name: 'Media controls', exact: true })
        .isVisible(),
      false,
    );
    const controls = viewer.getByRole('button', {
      name: 'Media controls',
      exact: true,
    });
    const panel = viewer.getByRole('dialog', {
      name: 'Media controls',
      exact: true,
    });
    await source
      .locator('video')
      .first()
      .evaluate((e) => (e.style.display = 'block'));
    await controls.waitFor({ state: 'visible' });
    assert.equal(
      await panel.isVisible(),
      false,
      'A visible failure remains available on demand without opening a popup',
    );
    await controls.click();
    await panel
      .getByText('This media cannot play in this browser.', { exact: true })
      .waitFor();
    assert.equal(
      await panel
        .getByRole('button', { name: 'Play source media', exact: true })
        .isEnabled(),
      false,
    );
    await panel
      .getByRole('button', { name: 'Mute audio', exact: true })
      .press('Escape');
    await panel.waitFor({ state: 'hidden' });
    assert.equal(
      await controls.evaluate((e) => e === document.activeElement),
      true,
      'Escape returns focus to the toolbar control',
    );
    await source
      .locator('video')
      .first()
      .evaluate((e) => (e.currentTime = 10));
    await controls.click();
    await panel.waitFor({ state: 'visible' });
    await controls.click();
    await panel.waitFor({ state: 'hidden' });
    await controls.click();
    await viewer
      .frameLocator('#viewport iframe')
      .getByRole('button', { name: 'Clicked', exact: true })
      .click();
    await panel.waitFor({ state: 'hidden' });
    await source
      .locator('video')
      .first()
      .evaluate((e) => (e.style.display = 'none'));
    await controls.waitFor({ state: 'hidden' });
  },
);

test(
  'page gestures unlock received audio while an explicit mute remains respected',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    const source = await browser.newPage();
    await source.goto(
      'data:text/html,' +
        encodeURIComponent(
          `<!doctype html><video width="320" height="180"></video><button id="play" onclick="document.querySelector('video').play()">Play video</button><button id="pause" onclick="document.querySelector('video').pause()">Pause video</button>`,
        ),
    );
    await source.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      let n = 0;
      setInterval(() => {
        ctx.fillStyle = ++n % 2 ? 'red' : 'blue';
        ctx.fillRect(0, 0, 320, 180);
      }, 40);
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const output = audio.createMediaStreamDestination();
      tone.connect(output);
      tone.start();
      const stream = canvas.captureStream(25);
      stream.addTrack(output.stream.getAudioTracks()[0]!);
      document.querySelector('video')!.srcObject = stream;
    });
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const viewer = await browser.newPage();
    await viewer.addInitScript(() => {
      // Deterministic autoplay refusal, lifted only by a real client gesture.
      (window as any).__name = (value: unknown) => value;
      (window as any).allowTestAudio = false;
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (
          this.srcObject &&
          !this.muted &&
          !(window.top as any).allowTestAudio
        )
          return Promise.reject(
            new DOMException('Gesture required', 'NotAllowedError'),
          );
        return play.call(this);
      };
    });
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const frame = viewer.frameLocator('#viewport iframe');
    await frame.locator('#play').click();
    await viewer.waitForFunction(() => {
      const video = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector('video');
      return (
        video &&
        video.muted &&
        video.getVideoPlaybackQuality().totalVideoFrames > 3
      );
    });
    assert.equal(
      await viewer
        .getByRole('dialog', { name: 'Media controls', exact: true })
        .isVisible(),
      false,
    );
    await viewer.evaluate(() => ((window as any).allowTestAudio = true));
    await frame.locator('#play').click();
    await viewer.waitForFunction(() => {
      const video = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector('video');
      return video && !video.muted && !video.paused;
    });
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .click();
    await viewer
      .getByRole('button', { name: 'Mute audio', exact: true })
      .click();
    await frame.locator('#pause').click();
    await frame.locator('#play').click();
    assert.equal(
      await frame.locator('video').evaluate((v: HTMLVideoElement) => v.muted),
      true,
      'An ordinary page gesture must not override an explicit mute',
    );
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .click();
    await viewer
      .getByRole('button', { name: 'Unmute audio', exact: true })
      .click();
    await source.locator('video').evaluate((v: HTMLVideoElement) => {
      v.muted = true;
      v.volume = 0.25;
    });
    await viewer.waitForFunction(() => {
      const video = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector('video');
      return video?.muted && video.volume === 0.25;
    });
    await source.locator('video').evaluate((v: HTMLVideoElement) => {
      v.style.display = 'none';
    });
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .waitFor({ state: 'hidden' });
    await source.locator('video').evaluate((v: HTMLVideoElement) => {
      v.muted = false;
    });
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(
      await viewer
        .getByRole('dialog', { name: 'Media controls', exact: true })
        .isVisible(),
      false,
      'Playing background audio stays controllable without reopening the popup',
    );
  },
);
