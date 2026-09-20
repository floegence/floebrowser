import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'media recovers after a temporary DOM detach and closes after source retirement',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    const source = await browser.newPage();
    // Hold only the media scan so detach/reattach is deterministic between scans.
    await source.addInitScript(() => {
      const interval = window.setInterval.bind(window);
      const scans: (() => void)[] = [];
      (window as any).scanMedia = () => scans.forEach((scan) => scan());
      window.setInterval = ((
        callback: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay === 500 && typeof callback === 'function') {
          scans.push(() => callback(...args));
          return interval(() => {
            if ((window as any).resumeScan) callback(...args);
          }, delay);
        }
        return interval(callback, delay, ...args);
      }) as typeof setInterval;
    });
    await source.goto(
      'data:text/html,<div id="player"><video id="clip" width="320" height="180" muted></video><span>Source captions</span></div><video id="preview" width="80" height="45" muted hidden></video>',
    );
    await source.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      let frame = 0;
      setInterval(() => {
        ctx.fillStyle = ++frame % 2 ? 'red' : 'blue';
        ctx.fillRect(0, 0, 320, 180);
      }, 40);
      for (const video of document.querySelectorAll('video')) {
        video.srcObject = canvas.captureStream(25);
        await video.play();
      }
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
      (window as any).mediaPeers = [];
      const Peer = RTCPeerConnection;
      (window as any).RTCPeerConnection = class extends Peer {
        constructor(configuration?: RTCConfiguration) {
          super(configuration);
          (window as any).mediaPeers.push(this);
        }
      };
    });
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const decoded = () =>
      viewer.waitForFunction(
        () => {
          const video = document
            .querySelector<HTMLIFrameElement>('#viewport iframe')
            ?.contentDocument?.querySelector<HTMLVideoElement>('#clip');
          return (
            video &&
            video.videoWidth === 320 &&
            video.getVideoPlaybackQuality().totalVideoFrames > 3
          );
        },
        null,
        { timeout: 5000 },
      );
    await decoded();
    const projected = viewer.frameLocator('#viewport iframe');
    await source.evaluate(() => {
      document.querySelector<HTMLVideoElement>('#clip')!.pause();
      (window as any).scanMedia();
    });
    await viewer.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector<HTMLVideoElement>('#clip')?.paused,
      null,
      { timeout: 2000 },
    );
    await source.evaluate(async () => {
      await document.querySelector<HTMLVideoElement>('#clip')!.play();
      (window as any).scanMedia();
    });
    await viewer.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector<HTMLVideoElement>('#clip')
          ?.paused === false,
    );
    const before = await projected
      .locator('#clip')
      .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).id);
    await source.evaluate(() => {
      (window as any).detachedClip = document.querySelector('#clip');
      (window as any).detachedClip.remove();
    });
    await projected.locator('#clip').waitFor({ state: 'detached' });
    await source.evaluate(async () => {
      const v = (window as any).detachedClip;
      document.querySelector('#player')!.prepend(v);
      await v.play();
    });
    await projected.locator('#clip').waitFor();
    await source.evaluate(() => {
      (window as any).resumeScan = true;
      (window as any).scanMedia();
    });
    await decoded();
    assert.notEqual(
      await projected
        .locator('#clip')
        .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).id),
      before,
      'Reinsertion establishes a fresh media session after both endpoints retire',
    );
    const reattached = await projected
      .locator('#clip')
      .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).id);
    await source.evaluate(async () => {
      const video = document.querySelector<HTMLVideoElement>('#clip')!;
      (window as any).originalTracks = (
        video.srcObject as MediaStream
      ).getTracks();
      video.srcObject = (video.srcObject as MediaStream).clone();
      await video.play();
      (window as any).scanMedia();
    });
    await viewer.waitForFunction((previous) => {
      const video = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector<HTMLVideoElement>('#clip');
      return (
        video?.srcObject && (video.srcObject as MediaStream).id !== previous
      );
    }, reattached);
    await decoded();
    assert.ok(
      await source.evaluate(() =>
        (window as any).originalTracks.every(
          (track: MediaStreamTrack) => track.readyState === 'live',
        ),
      ),
      'Retirement must not stop the page-owned media tracks',
    );
    await source.evaluate(() => {
      (window as any).detachedClip.remove();
      (window as any).scanMedia();
    });
    await viewer.waitForFunction(
      () =>
        (window as any).mediaPeers.filter(
          (p: RTCPeerConnection) => p.connectionState !== 'closed',
        ).length === 1,
    );
    assert.equal(
      await viewer.locator('.floe-media-dock summary').textContent(),
      'Media · 1',
    );
    await source.evaluate(() => {
      document.querySelector('#preview')!.remove();
      (window as any).scanMedia();
    });
    await viewer.locator('.floe-media-dock').waitFor({ state: 'hidden' });
    assert.equal(
      await viewer.evaluate(
        () =>
          (window as any).mediaPeers.filter(
            (p: RTCPeerConnection) => p.connectionState !== 'closed',
          ).length,
      ),
      0,
    );
  },
);

test(
  'replacing a cross-origin media document retires old peers without exhausting the media limit',
  { timeout: 30000 },
  async (t) => {
    const { createServer } = await import('node:http');
    const site = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        req.url === '/'
          ? `<iframe src="http://localhost:${(site.address() as { port: number }).port}/child" width="400" height="250"></iframe>`
          : `<video id="clip" width="320" height="180" muted></video><script>
      const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180;
      const ctx=canvas.getContext('2d');let n=0;
      setInterval(()=>{ctx.fillStyle=++n%2?'red':'blue';ctx.fillRect(0,0,320,180)},40);
      clip.srcObject=canvas.captureStream(25);clip.play();
    </script>`,
      );
    });
    await new Promise<void>((resolve) => site.listen(0, resolve));
    const port = (site.address() as { port: number }).port;
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    });
    await source.goto(`http://127.0.0.1:${port}/`);
    const viewer = await browser.newPage();
    await viewer.addInitScript(() => {
      (window as any).mediaPeers = [];
      const Peer = RTCPeerConnection;
      (window as any).RTCPeerConnection = class extends Peer {
        constructor(c?: RTCConfiguration) {
          super(c);
          (window as any).mediaPeers.push(this);
        }
      };
    });
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    for (let i = 0; i < 10; i++) {
      if (i)
        await source
          .frames()[1]!
          .goto(`http://localhost:${port}/child?revision=${i}`);
      await viewer.waitForFunction(
        () => {
          const root =
            document.querySelector<HTMLIFrameElement>(
              '#viewport iframe',
            )?.contentDocument;
          const video = root
            ?.querySelector<HTMLIFrameElement>('iframe')
            ?.contentDocument?.querySelector<HTMLVideoElement>('video');
          return (
            video &&
            video.videoWidth === 320 &&
            video.getVideoPlaybackQuality().totalVideoFrames > 3
          );
        },
        null,
        { timeout: 4000 },
      );
      assert.equal(
        await viewer.evaluate(
          () =>
            (window as any).mediaPeers.filter(
              (p: RTCPeerConnection) => p.connectionState !== 'closed',
            ).length,
        ),
        1,
        'Each frame document has exactly one current receiver',
      );
    }
    await source.locator('iframe').evaluate((frame) => frame.remove());
    await viewer
      .locator('.floe-media-dock')
      .waitFor({ state: 'hidden', timeout: 3000 });
    assert.equal(
      await viewer.evaluate(
        () =>
          (window as any).mediaPeers.filter(
            (p: RTCPeerConnection) => p.connectionState !== 'closed',
          ).length,
      ),
      0,
    );
  },
);
