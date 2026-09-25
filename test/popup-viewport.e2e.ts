import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { PlaywrightSourceBrowser } from '../dist/host/playwright-source.js';
import { createProjectionServer } from '../dist/host/server.js';
import { clickProjected } from './projected-input.js';

for (const { width, zoom } of [
  { width: 1536, zoom: 1 },
  { width: 720, zoom: 1 },
  { width: 1536, zoom: 1.5 },
])
  test(
    `owned window initializes new tabs at display size: width=${width}, opener zoom=${zoom}`,
    { timeout: 30000 },
    async (t) => {
      const browser = await chromium.launch({ channel: 'chromium' });
      const context = await browser.newContext({ viewport: null });
      const client = await chromium.launch({ channel: 'chromium' });
      const owner = new PlaywrightSourceBrowser({ windowViewport: true });
      const parent = await context.newPage();
      await context.route('https://popup-layout.test/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body:
            new URL(route.request().url()).pathname === '/parent'
              ? '<title>Parent</title><button onclick="window.open(\'/child\')">Open panel</button>'
              : `<!doctype html><title>Point selection</title><style>
        body{margin:0}#panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:320px;height:180px;background:lightblue;overflow:hidden}
        #marker{position:absolute;width:20px;height:20px;border-radius:50%;background:navy;color:white;text-align:center;pointer-events:none}
        </style><div id="panel"></div><script>
        window.initialViewport=[innerWidth,innerHeight];
        const panel=document.querySelector('#panel'),bounds=panel.getBoundingClientRect();
        panel.addEventListener('click',event=>{if(!event.isTrusted)return;const marker=document.createElement('span');marker.id='marker';marker.textContent='1';marker.style.left=(event.clientX-bounds.left-10)+'px';marker.style.top=(event.clientY-bounds.top-10)+'px';panel.append(marker)});
        </script>`,
        }),
      );
      const source = await owner.adopt(parent);
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(async () => {
        await service.close();
        await owner.dispose();
        await client.close();
        await browser.close();
      });
      await parent.goto('https://popup-layout.test/parent');
      const viewer = await client.newPage({
        viewport: { width, height: 960 },
      });
      viewer.setDefaultTimeout(5000);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const expected = await parent.evaluate(() => [innerWidth, innerHeight]);
      if (zoom !== 1) {
        await viewer
          .getByRole('button', { name: 'Page zoom', exact: true })
          .click();
        for (const factor of [1.1, 1.25, zoom]) {
          await viewer
            .getByRole('button', { name: 'Zoom in', exact: true })
            .click();
          await parent.waitForFunction(
            (factor) => Math.abs(devicePixelRatio - factor) < 0.001,
            factor,
            { timeout: 5000 },
          );
        }
        await viewer
          .getByRole('button', { name: 'Page zoom', exact: true })
          .click();
      }
      const parentViewport = await parent.evaluate(() => [
        innerWidth,
        innerHeight,
        devicePixelRatio,
      ]);
      const opened = context.waitForEvent('page');
      await clickProjected(
        viewer
          .frameLocator('#viewport iframe')
          .getByRole('button', { name: 'Open panel' }),
      );
      const popup = await opened;
      await popup.waitForLoadState();
      assert.deepEqual(
        await popup.evaluate(() => (window as any).initialViewport),
        expected,
        'A new tab must inherit the controlled window before its scripts cache layout',
      );
      await viewer.waitForFunction(
        () =>
          document.querySelector('#viewport iframe')?.contentDocument?.title ===
            'Point selection' &&
          document.querySelector('#status.live') &&
          !document.querySelector('.stage.switching'),
      );
      assert.deepEqual(
        await parent.evaluate(() => [
          innerWidth,
          innerHeight,
          devicePixelRatio,
        ]),
        parentViewport,
        'Admitting the popup must preserve the existing parent tab viewport and zoom',
      );
      const panel = viewer.frameLocator('#viewport iframe').locator('#panel');
      await clickProjected(panel, { position: { x: 80, y: 60 } });
      await popup.locator('#marker').waitFor();
      await viewer
        .frameLocator('#viewport iframe')
        .locator('#marker')
        .waitFor();
      const replayElement = await viewer
        .locator('#viewport iframe')
        .elementHandle();
      const replay = await replayElement!.contentFrame();
      assert.ok(replay);
      for (const page of [popup.mainFrame(), replay]) {
        assert.deepEqual(
          await page.evaluate(() => {
            const panel = document
                .querySelector('#panel')!
                .getBoundingClientRect(),
              marker = document
                .querySelector('#marker')!
                .getBoundingClientRect();
            return {
              x: marker.left - panel.left + marker.width / 2,
              y: marker.top - panel.top + marker.height / 2,
            };
          }),
          { x: 80, y: 60 },
          'The source and projection must show the real click marker at the clicked point',
        );
      }
    },
  );

test(
  'borrowed page sizing never changes its native browser window',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch({ channel: 'chromium' });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    const owner = new PlaywrightSourceBrowser();
    t.after(async () => {
      await owner.dispose();
      await browser.close();
    });
    const source = await owner.adopt(page);
    const before = await source.transport.send('Browser.getWindowForTarget');
    await source.setViewportSize({ width: 1536, height: 960 });
    const after = await source.transport.send('Browser.getWindowForTarget');
    assert.deepEqual(after.bounds, before.bounds);
    assert.deepEqual(
      await page.evaluate(() => [innerWidth, innerHeight]),
      [1536, 960],
    );
  },
);
