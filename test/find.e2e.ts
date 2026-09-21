import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'find searches and scrolls the real source, including a cross-origin frame, without stealing the query focus',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.route('http://search.test/', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><title>Find fixture</title><p>Garden first</p><div style="height:1200px"></div><p>Garden second</p><iframe src="http://child.test/" style="display:block;width:600px;height:200px"></iframe>`,
      }),
    );
    await context.route('http://child.test/', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><p>Garden child</p><p>中文搜尋 🪷</p>',
      }),
    );
    const source = await context.newPage();
    source.setDefaultTimeout(3000);
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    await source.goto('http://search.test/');
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(4000);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await viewer
      .getByRole('button', { name: 'Find in page', exact: true })
      .click();
    const input = viewer.getByRole('searchbox', {
      name: 'Find in page',
      exact: true,
    });
    await input.fill('Garden');
    await source.waitForFunction(() => getSelection()?.toString() === 'Garden');
    await viewer.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.getSelection()
          ?.toString() === 'Garden',
    );
    await input.press('Enter');
    await source.waitForFunction(
      () =>
        (getSelection()?.anchorNode?.textContent ?? '').includes('second') &&
        scrollY > 500,
    );
    assert.equal(
      await input.evaluate((node) => node === document.activeElement),
      true,
    );
    await input.press('Enter');
    const child = source
      .frames()
      .find((frame) => frame.url() === 'http://child.test/')!;
    await child.waitForFunction(() => getSelection()?.toString() === 'Garden');
    await input.fill('中文搜尋');
    await child.waitForFunction(
      () => getSelection()?.toString() === '中文搜尋',
    );
    await input.fill('No such phrase');
    await viewer
      .getByRole('status')
      .filter({ hasText: 'No matches' })
      .waitFor();
    await viewer.waitForFunction(() => {
      const doc =
        document.querySelector<HTMLIFrameElement>(
          '#viewport iframe',
        )?.contentDocument;
      return (
        !doc?.getSelection()?.toString() &&
        !doc
          ?.querySelector<HTMLIFrameElement>('iframe')
          ?.contentDocument?.getSelection()
          ?.toString()
      );
    });
    await input.fill('Garden');
    await source.waitForFunction(() =>
      (getSelection()?.anchorNode?.textContent ?? '').includes('first'),
    );
    await input.press('Shift+Enter');
    await child.waitForFunction(() => getSelection()?.toString() === 'Garden');
    await input.press('Escape');
    assert.equal(await input.isVisible(), false);
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);
