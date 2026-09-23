import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'WebGPU element pixels survive presentation and update after later queue submission',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({ channel: 'chromium' });
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    await source.route('http://127.0.0.1/graphics', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<canvas id="scene" width="200" height="120" tabindex="0"></canvas>',
      }),
    );
    await source.goto('http://127.0.0.1/graphics');
    await source.evaluate(async () => {
      const gpu = (navigator as any).gpu;
      const adapter = await gpu.requestAdapter();
      if (!adapter)
        throw new Error('The qualification source must provide WebGPU');
      const device = await adapter.requestDevice();
      const canvas = document.querySelector('canvas')!;
      const context = canvas.getContext('webgpu') as any;
      context.configure({
        device,
        format: gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
      });
      (window as any).render = (color: number[]) => {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: color,
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        pass.end();
        device.queue.submit([encoder.finish()]);
      };
      (window as any).render([1, 0, 0, 0.5]);
      (window as any).prepare = () => {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: [0, 0, 1, 1],
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        pass.end();
        (window as any).submit = () => device.queue.submit([encoder.finish()]);
      };
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(4000);
    await viewer.goto(service.url);
    const pixels = ({ channel, alpha }: { channel: number; alpha: number }) => {
      const image = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector<HTMLImageElement>('#scene');
      if (
        !image?.complete ||
        image.naturalWidth !== 200 ||
        !image.src.startsWith('blob:') ||
        image.hasAttribute('data-floebrowser-unsupported')
      )
        return false;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0, 1, 1);
      const rgba = context.getImageData(0, 0, 1, 1).data;
      return rgba[channel]! > 220 && Math.abs(rgba[3]! - alpha) < 10;
    };
    await viewer.waitForFunction(pixels, { channel: 0, alpha: 128 });
    await source.evaluate(async () => {
      (window as any).prepare();
      await Promise.resolve();
      (window as any).submit();
    });
    await viewer.waitForFunction(pixels, { channel: 2, alpha: 255 });
    await viewer.reload();
    await viewer.waitForFunction(pixels, { channel: 2, alpha: 255 });
    assert.equal(
      await viewer.locator('#viewport iframe').getAttribute('sandbox'),
      'allow-same-origin',
    );
  },
);
