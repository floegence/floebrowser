import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { CDPSourcePage } from '../src/host/cdp-source.js';

test(
  'source titles change without a projection and stop observing on disposal',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(
      'data:text/html,<title>Initial</title><iframe srcdoc="<title>Child</title>"></iframe>',
    );
    const transport = await page.context().newCDPSession(page);
    const source = await CDPSourcePage.attach({
      id: 'title-source',
      transport,
    });
    t.after(() => source.dispose());
    const titles: string[] = [];
    source.on('titlechanged', (title) => titles.push(title));
    const expectTitle = async (title: string) => {
      const deadline = Date.now() + 3000;
      while (titles.at(-1) !== title && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(titles.at(-1), title);
    };
    await page.evaluate(() => {
      document.title = 'Background';
    });
    await expectTitle('Background');
    await page.frames()[1].evaluate(() => {
      document.title = 'Child renamed';
    });
    await page.evaluate(() => {
      document.head.innerHTML = '<title>Replaced</title>';
    });
    await expectTitle('Replaced');
    await page.goto('data:text/html,<title>Navigated</title>');
    await expectTitle('Navigated');
    await page.evaluate(() => {
      document.title = '';
    });
    await expectTitle('');
    assert.ok(!titles.includes('Child renamed'));
    source.dispose();
    const count = titles.length;
    await page.evaluate(() => {
      document.title = 'After disposal';
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(titles.length, count);
    assert.equal(page.isClosed(), false);
  },
);
