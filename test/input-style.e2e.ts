import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { clickProjected, hoverProjected } from './projected-input.js';

for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} preserves source pseudo styles and private fonts while editing`,
    { timeout: 20000 },
    async (t) => {
      const sourceBrowser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() =>
        Promise.all([sourceBrowser.close(), viewerBrowser.close()]),
      );
      const source = await sourceBrowser.newPage();
      source.setDefaultTimeout(4000);
      const font = await readFile(
        'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2',
      );
      await source.route('http://input-style.test/**', (route) =>
        route.fulfill(
          route.request().url().endsWith('/font')
            ? { contentType: 'font/woff2', body: font }
            : {
                contentType: 'text/html',
                body: `<!doctype html><style>
      @font-face{font-family:PrivateInput;src:url('/font')}
      body{margin:20px;background:linear-gradient(120deg,#eff5ff,#c6d8f0);font:16px system-ui}
      section{padding:12px}section:focus-within{background:rgb(210,225,240)}
      input{font:24px PrivateInput;width:400px;padding:12px;background:rgb(255,255,255);border:1px solid #abc;outline:none}
      input:focus{border-color:rgb(30,90,170)}input:focus-visible{outline:2px solid rgb(20,140,90)}
      button{width:180px;height:40px;background:rgb(240,240,240)}button:hover{background:rgb(30,90,170)}button:active{background:rgb(170,30,90)}
      </style><section><input value="Minimum width MW 0123456789"><button>Action</button></section>`,
              },
        ),
      );
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(() => service.close());
      await source.goto('http://input-style.test/');
      const viewer = await viewerBrowser.newPage();
      viewer.setDefaultTimeout(4000);
      const external: string[] = [];
      await viewer.route('**/*', (route) => {
        if (
          new URL(route.request().url()).origin === new URL(service.url).origin
        )
          return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const content = viewer.frameLocator('#viewport iframe');
      await hoverProjected(content.locator('button'));
      await viewer.waitForFunction(
        () =>
          getComputedStyle(
            document
              .querySelector<HTMLIFrameElement>('#viewport iframe')!
              .contentDocument!.querySelector('button')!,
          ).backgroundColor === 'rgb(30, 90, 170)',
      );
      await viewer.mouse.down();
      await viewer.waitForFunction(
        () =>
          getComputedStyle(
            document
              .querySelector<HTMLIFrameElement>('#viewport iframe')!
              .contentDocument!.querySelector('button')!,
          ).backgroundColor === 'rgb(170, 30, 90)',
      );
      await viewer.mouse.up();
      await clickProjected(content.locator('input'));
      await viewer.locator('.floe-input-proxy').waitFor();
      await viewer.waitForFunction(
        () =>
          getComputedStyle(
            document
              .querySelector<HTMLIFrameElement>('#viewport iframe')!
              .contentDocument!.querySelector('input')!,
          ).borderTopColor === 'rgb(30, 90, 170)',
      );
      await viewer.waitForFunction(
        () =>
          getComputedStyle(
            document
              .querySelector<HTMLIFrameElement>('#viewport iframe')!
              .contentDocument!.querySelector('section')!,
          ).backgroundColor === 'rgb(210, 225, 240)',
      );
      const measure = (node: Element) => {
        const style = getComputedStyle(node);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!;
        context.font = `${style.fontSize} ${style.fontFamily}`;
        return context.measureText('Minimum width MW 0123456789').width;
      };
      const expected = await source.locator('input').evaluate(measure);
      await viewer.locator('.floe-input-proxy').evaluate(async (node) => {
        await node.ownerDocument.fonts.ready;
      });
      assert.ok(
        Math.abs(
          (await viewer.locator('.floe-input-proxy').evaluate(measure)) -
            expected,
        ) < 2,
        'The native caret uses the same private font metrics as the source',
      );
      assert.equal(
        await viewer.evaluate(() =>
          [...document.fonts].some((font) => /PrivateInput/i.test(font.family)),
        ),
        false,
        'Website font names do not enter the host font namespace',
      );
      // Search fields often extend underneath sibling buttons. The trusted
      // caret layer must not repaint their background, border or shadows above
      // those siblings; the inert source document owns those decorations.
      assert.equal(
        await viewer
          .locator('.floe-input-proxy')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
        'rgba(0, 0, 0, 0)',
      );
      await source.locator('input').evaluate((node) => {
        node.style.backgroundColor = 'rgb(255, 255, 255)';
        const button = node.nextElementSibling as HTMLElement;
        button.style.cssText =
          'position:absolute;left:330px;top:35px;width:110px;height:40px;background:rgb(20,100,200)';
      });
      await viewer.waitForFunction(() => {
        const input = document
          .querySelector<HTMLIFrameElement>('#viewport iframe')!
          .contentDocument!.querySelector('input')!;
        return getComputedStyle(input).backgroundColor === 'rgb(255, 255, 255)';
      });
      await viewer.waitForFunction(
        () =>
          getComputedStyle(
            document
              .querySelector<HTMLIFrameElement>('#viewport iframe')!
              .contentDocument!.querySelector('button')!,
          ).position === 'absolute',
      );
      assert.equal(
        await viewer
          .locator('.floe-input-proxy')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
        'rgba(0, 0, 0, 0)',
        'The native caret does not paint over the source search button',
      );
      const overlay = await content.locator('button').boundingBox();
      assert.ok(overlay);
      const pixels = await viewer.screenshot({
        clip: { x: overlay.x + 5, y: overlay.y + 5, width: 2, height: 2 },
      });
      const color = await viewer.evaluate(
        async (bytes) => {
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
          );
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          return [...context.getImageData(0, 0, 1, 1).data];
        },
        [...pixels],
      );
      assert.deepEqual(
        color,
        [20, 100, 200, 255],
        'The overlapping button remains visually intact',
      );
      await viewer.keyboard.press('Tab');
      await viewer.waitForFunction(() =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')!
          .contentDocument!.querySelector('button')!
          .hasAttribute('data-floebrowser-focus-visible'),
      );
      assert.equal(await viewer.locator('.floe-input-proxy').count(), 0);
      assert.equal(
        await content
          .locator('input')
          .getAttribute('data-floebrowser-input-proxy'),
        null,
      );
      assert.equal(
        await viewer.evaluate(
          () =>
            [...document.fonts].filter((font) =>
              font.family.startsWith('floe-input-'),
            ).length,
        ),
        0,
        'Input font aliases are released on blur',
      );
      assert.deepEqual(external, []);
    },
  );
