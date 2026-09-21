import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'losing the media carrier stops unused source encoding without revoking browser input',
  { timeout: 12000 },
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
      'data:text/html,<video muted width=160 height=90></video><button onclick="this.textContent=\'Clicked\'">Click</button>',
    );
    await source.evaluate(async () => {
      const Original = RTCPeerConnection;
      (window as any).peers = [];
      (window as any).RTCPeerConnection = class extends Original {
        constructor(options?: RTCConfiguration) {
          super(options);
          (window as any).peers.push(this);
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
      }, 40);
      const video = document.querySelector('video')!;
      video.srcObject = canvas.captureStream(25);
      await video.play();
    });
    const viewer = await browser.newPage();
    await viewer.addInitScript(() => {
      const Original = WebSocket;
      (window as any).WebSocket = class extends Original {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          if (String(args[0]).includes('/media?'))
            (window as any).mediaSocket = this;
        }
      };
    });
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await source.waitForFunction(() =>
      (window as any).peers.some(
        (p: RTCPeerConnection) => p.connectionState === 'connected',
      ),
    );
    await viewer.evaluate(() => (window as any).mediaSocket.close());
    await source.waitForFunction(
      () =>
        (window as any).peers.every(
          (p: RTCPeerConnection) => p.connectionState === 'closed',
        ),
      null,
      { timeout: 2000 },
    );
    await clickProjected(
      viewer
        .frameLocator('#viewport iframe')
        .getByRole('button', { name: 'Click', exact: true }),
    );
    await source
      .getByRole('button', { name: 'Clicked', exact: true })
      .waitFor();
    assert.equal(await viewer.locator('#status').textContent(), 'Live');
  },
);
