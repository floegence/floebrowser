import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('media state arriving before its DOM surfaces only audible background playback', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { MediaView } from './src/viewer/media.js';
        window.media = new MediaView(document.body, () => document.querySelector('video'), async () => true, () => {});
        window.state = {kind:'state',id:1,stream:'fixture',paused:false,time:1,duration:20,muted:true,volume:1,status:'streaming',reason:''};
        window.receive = () => window.media.receive(window.state, {target:'fixture',view:'fixture'});
      `,
    },
    bundle: true,
    format: 'iife',
    write: false,
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://127.0.0.1/fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<body></body>' }),
  );
  await page.goto('http://127.0.0.1/fixture');
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.evaluate(() => (window as any).receive());
  assert.equal(
    await page.locator('.floe-media-row').count(),
    0,
    'Muted state alone cannot create phantom playback controls',
  );
  assert.equal(
    await page.evaluate(() =>
      (window as any).media.nodeID('fixture', 'fixture'),
    ),
    1,
    'Presentation does not revoke the authorized media stream',
  );
  await page.evaluate(() => {
    const w = window as any;
    w.state.muted = false;
    w.receive();
  });
  assert.equal(
    await page.locator('.floe-media-row:not([hidden])').count(),
    1,
    'Audible background media remains controllable without projected DOM',
  );
  await page.evaluate(() => {
    const w = window as any;
    w.state.muted = true;
    const video = document.createElement('video');
    video.width = 320;
    video.height = 180;
    video.hidden = true;
    document.body.append(video);
    w.receive();
  });
  assert.equal(await page.locator('.floe-media-row:not([hidden])').count(), 0);
  await page.evaluate(() => {
    document.querySelector('video')!.hidden = false;
    (window as any).receive();
  });
  assert.equal(
    await page.locator('.floe-media-row:not([hidden])').count(),
    1,
    'Visible muted video retains source controls after DOM is ready',
  );
  await page.evaluate(() => (window as any).media.destroy());
});
