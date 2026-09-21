import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'a stalled media consumer stays bounded while input works, then displays current frames',
  { timeout: 60000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      chromiumSandbox: true,
    });
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    await source.goto(
      'data:text/html,<title>Media pressure</title><video width=640 height=360 muted></video><button id=count onclick="this.textContent=String(++window.clicks)">Count</button><script>window.clicks=0</script>',
    );
    await source.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d')!;
      let n = 0;
      setInterval(() => {
        ctx.fillStyle = (window as any).color ?? (++n % 2 ? 'red' : 'blue');
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = 'white';
        ctx.fillText(String(++n), 30, 30);
      }, 30);
      const video = document.querySelector('video')!;
      video.srcObject = canvas.captureStream(30);
      await video.play();
    });
    const viewer = await browser.newPage();
    await viewer.addInitScript(() => {
      (window as any).RTCPeerConnection = class {
        constructor() {
          throw new Error('Client RTC is forbidden');
        }
      };
      (window as any).mediaHeld = false;
      const Socket = WebSocket;
      (window as any).WebSocket = class extends Socket {
        private acknowledgement?: Parameters<WebSocket['send']>[0];
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          if (String(args[0]).includes('/stream'))
            (window as any).controlSocket = this;
          if (String(args[0]).includes('/media?'))
            (window as any).resumeMedia = () => {
              (window as any).mediaHeld = false;
              if (this.acknowledgement) super.send(this.acknowledgement);
              this.acknowledgement = undefined;
            };
        }
        send(data: Parameters<WebSocket['send']>[0]) {
          if (this.url.includes('/media?') && (window as any).mediaHeld) {
            this.acknowledgement = data;
            return;
          }
          super.send(data);
        }
      };
    });
    let bytes = 0;
    const encodedControl: unknown[] = [];
    viewer.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        if (socket.url().includes('/media?')) {
          bytes += payload.length;
          assert.ok(payload.length <= 16384);
        } else if (typeof payload !== 'string') encodedControl.push(payload);
        else {
          const message = JSON.parse(payload);
          if (
            message.type === 'media' &&
            (message.packet.sdp || message.packet.data)
          )
            encodedControl.push(message);
        }
      }),
    );
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const root = viewer.frameLocator('#viewport iframe');
    const decoded = () =>
      root
        .locator('video')
        .evaluate(
          (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames,
        );
    const wait = async (fn: () => Promise<boolean>) => {
      const end = Date.now() + 8000;
      while (!(await fn()) && Date.now() < end)
        await new Promise((done) => setTimeout(done, 50));
      assert.ok(await fn());
    };
    await wait(async () => (await decoded()) > 3);
    await viewer.evaluate(() => {
      (window as any).mediaHeld = true;
    });
    await new Promise((done) => setTimeout(done, 500));
    const stalledFrames = await decoded(),
      stalledBytes = bytes;
    const clicks: number[] = [];
    for (let i = 1; i <= 8; i++) {
      const start = performance.now();
      await root.locator('#count').click();
      await source.waitForFunction((n) => (window as any).clicks === n, i, {
        timeout: 1500,
      });
      clicks.push(performance.now() - start);
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.equal(
      bytes,
      stalledBytes,
      'Unacknowledged media cannot fill an unbounded socket queue',
    );
    assert.ok(
      (await decoded()) <= stalledFrames + 2,
      'The consumer is actually stalled',
    );
    assert.ok(
      Math.max(...clicks) < 1500,
      'Input works while the separate media carrier is stalled',
    );
    await source.evaluate(() => {
      (window as any).color = 'lime';
    });
    await viewer.evaluate(() => {
      (window as any).resumeMedia();
    });
    await wait(async () => (await decoded()) > stalledFrames + 10);
    await wait(() =>
      root.locator('video').evaluate((video: HTMLVideoElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(video, 0, 0, 1, 1);
        const pixel = ctx.getImageData(0, 0, 1, 1).data;
        return pixel[1]! > 180 && pixel[0]! < 80 && pixel[2]! < 80;
      }),
    );
    const stream = await root
      .locator('video')
      .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).id);
    await source.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
    const old = await viewer.locator('#viewport iframe').elementHandle();
    await viewer.evaluate(() =>
      (window as any).controlSocket.send(JSON.stringify({ type: 'resync' })),
    );
    await viewer.waitForFunction((node) => !node!.isConnected, old);
    await wait(() =>
      root
        .locator('video')
        .evaluate((v: HTMLVideoElement) => v.videoWidth === 640),
    );
    assert.equal(
      await root
        .locator('video')
        .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).id),
      stream,
      'DOM checkpoints preserve a paused picture',
    );
    assert.deepEqual(encodedControl, []);
    t.diagnostic(
      JSON.stringify({
        stalledBytes,
        totalMediaBytes: bytes,
        maxClickMs: Math.round(Math.max(...clicks)),
      }),
    );
  },
);
