import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'navigation intent fences old-page input through host admission and source completion',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch();
    const source = await browser.newPage();
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    await source.route('http://navigation-input.test/**', async (route) => {
      if (route.request().url().endsWith('/next')) await response;
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><button style="width:300px;height:160px" onclick="window.clicks++">Action</button><div style="height:3000px"></div><script>window.clicks=0</script>',
      });
    });
    await source.goto('http://navigation-input.test/');
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      release();
      await service.close();
      await browser.close();
    });
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
    import { mountBrowser, webSocketConnection } from './src/viewer/index.js';
    window.sent=[]; window.admissions=[];
    mountBrowser(document.body, { idPrefix:'', connect:()=>{
      const url=new URL('stream',location.href);url.protocol='ws:';
      const connection=webSocketConnection(url.href), send=connection.send.bind(connection);
      connection.send=m=>{if(m.type==='command')window.sent.push(m.action.kind);send(m)};
      return connection;
    }, onRequestControl:()=>new Promise((resolve,reject)=>window.admissions.push({resolve,reject})) });
  `,
      },
      bundle: true,
      format: 'iife',
      write: false,
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(4000);
    await viewer.route('**/app.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: bundle.outputFiles[0]!.text,
      }),
    );
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const old = await viewer
      .frameLocator('#viewport iframe')
      .locator('button')
      .boundingBox();
    await viewer.locator('#address').fill('http://navigation-input.test/next');
    await viewer.locator('#address').press('Enter');
    for (const phase of ['admission', 'navigation']) {
      if (phase === 'navigation') {
        await viewer.evaluate(() =>
          (window as any).admissions.at(-1).resolve(),
        );
        await viewer
          .getByRole('button', { name: 'Stop loading', exact: true })
          .waitFor();
      }
      await viewer.mouse.click(old!.x + 50, old!.y + 50);
      await viewer.mouse.wheel(0, 100);
      await viewer.waitForTimeout(100);
      assert.equal(
        await viewer.evaluate(() =>
          (window as any).sent.some((kind: string) =>
            ['pointer', 'wheel'].includes(kind),
          ),
        ),
        false,
        `${phase} must not dispatch input to the old document`,
      );
    }
    release();
    await source.waitForURL('http://navigation-input.test/next');
    await viewer.locator('#status.live').waitFor();
    const next = await viewer
      .frameLocator('#viewport iframe')
      .locator('button')
      .boundingBox();
    await viewer.mouse.click(next!.x + 50, next!.y + 50);
    await source.waitForFunction(() => (window as any).clicks === 1);
    assert.equal(await viewer.locator('#toast').isVisible(), false);

    // Rejected admission restores the current page without replaying a gesture.
    await viewer
      .locator('#address')
      .fill('http://navigation-input.test/next#denied');
    await viewer.locator('#address').press('Enter');
    await viewer.evaluate(() =>
      (window as any).admissions.at(-1).reject(new Error('denied')),
    );
    await viewer.locator('#toast').waitFor();
    await viewer.mouse.click(next!.x + 50, next!.y + 50);
    await source.waitForFunction(() => (window as any).clicks === 2);

    // A late completion cannot release the newer navigation's input fence.
    for (const hash of ['superseded', 'current']) {
      await viewer
        .locator('#address')
        .fill(`http://navigation-input.test/next#${hash}`);
      await viewer.locator('#address').press('Enter');
    }
    await viewer.evaluate(() => (window as any).admissions.at(-2).resolve());
    await viewer.mouse.click(next!.x + 50, next!.y + 50);
    await viewer.waitForTimeout(100);
    assert.equal(await source.evaluate(() => (window as any).clicks), 2);
    await viewer.evaluate(() => (window as any).admissions.at(-1).resolve());
    await source.waitForURL('http://navigation-input.test/next#current');
    await viewer.locator('#status.live').waitFor();
    await viewer.mouse.click(next!.x + 50, next!.y + 50);
    await source.waitForFunction(() => (window as any).clicks === 3);
  },
);
