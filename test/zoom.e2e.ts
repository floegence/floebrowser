import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'page zoom reflows source layout and pixel density, preserves input mapping and survives viewport changes',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const source = await context.newPage();
    source.setDefaultTimeout(3000);
    await source.route('http://zoom.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><style>body{margin:0}button{width:200px;height:80px}</style><button onclick="this.textContent=\'Clicked at source\'">Zoom target</button>',
      }),
    );
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    await source.goto('http://zoom.test/');
    const viewer = await browser.newPage({
      viewport: { width: 960, height: 700 },
    });
    viewer.setDefaultTimeout(3000);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await source.waitForFunction(() => innerWidth === 960);
    await viewer
      .getByRole('button', { name: 'Page zoom', exact: true })
      .click();
    await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await source.waitForFunction(
      () =>
        Math.abs(devicePixelRatio - 1.1) < 0.001 &&
        innerWidth === Math.round(960 / 1.1),
    );
    const button = viewer.frameLocator('#viewport iframe').getByRole('button');
    await viewer
      .getByRole('button', { name: 'Page zoom', exact: true })
      .click();
    await clickProjected(button);
    await source
      .getByRole('button', { name: 'Clicked at source', exact: true })
      .waitFor();
    assert.equal(
      await source.locator('button').textContent(),
      'Clicked at source',
    );
    const physicalWidth = (await button.boundingBox())!.width;
    assert.ok(Math.abs(physicalWidth - 220) < 1);
    assert.equal(
      await source
        .locator('button')
        .evaluate((node) => node.getBoundingClientRect().width),
      200,
    );
    assert.equal(await source.locator('html').getAttribute('style'), null);
    await viewer.setViewportSize({ width: 720, height: 640 });
    await source.waitForFunction(() => innerWidth === Math.round(720 / 1.1));
    await viewer
      .getByRole('button', { name: 'Page zoom', exact: true })
      .click();
    await viewer
      .getByRole('button', { name: 'Reset zoom', exact: true })
      .click();
    await source.waitForFunction(
      () => devicePixelRatio === 1 && innerWidth === 720,
    );
    for (let i = 0; i < 3; i++) await viewer.keyboard.press('Control+=');
    await source.waitForFunction(
      () => devicePixelRatio === 1.5 && innerWidth === 480,
    );
    const original = service.session.currentState.active;
    await viewer.reload();
    await viewer.locator('#status.live').waitFor();
    assert.equal(
      await viewer
        .getByRole('button', { name: 'Page zoom', exact: true })
        .textContent(),
      '150%',
    );
    await viewer.locator('#new-tab').click();
    await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
    assert.equal(
      await viewer
        .getByRole('button', { name: 'Page zoom', exact: true })
        .textContent(),
      '100%',
    );
    await viewer.locator(`[data-tab="${original}"]`).click();
    await viewer.locator('#status.live').waitFor();
    assert.equal(await source.evaluate(() => devicePixelRatio), 1.5);
    assert.equal(
      await viewer
        .getByRole('button', { name: 'Page zoom', exact: true })
        .textContent(),
      '150%',
    );
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);
