import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

test('host menu shares the address row and preserves activation, focus and mount lifetime', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { mountBrowser } from './src/viewer/index.js';
    window.calls = []; window.failures = 0;
    const connect = () => ({send(){}, subscribe(){return () => {};}, onDisconnect(){return () => {};}, close(){}});
    window.view = mountBrowser(document.querySelector('#host'), {
      connect,
      menu: {label:'More browser actions', actions:[
        {label:'Choose source', description:'<img src=x onerror=alert(1)>', run(){window.calls.push(navigator.userActivation.isActive);}, failureMessage:'Source unavailable'},
        {label:'Open window', run(){window.failures++; return new Promise((_,reject) => {window.rejectAction = reject;});}, failureMessage:'Window unavailable'}
      ]}
    });
    window.other = mountBrowser(document.querySelector('#other'), {connect});
  `,
    },
    bundle: true,
    format: 'iife',
    write: false,
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 480, height: 600 } });
  page.setDefaultTimeout(3000);
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    t.diagnostic(error.stack ?? error.message);
  });
  await page.route('http://127.0.0.1/menu', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="outside">Outside</button><div id="host" style="height:400px"></div><div id="other"></div>',
    }),
  );
  await page.goto('http://127.0.0.1/menu');
  await page.addStyleTag({
    content: await readFile('src/viewer/style.css', 'utf8'),
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const more = page.getByRole('button', { name: 'More browser actions' });
  await more.waitFor();
  const [toolbar, trigger] = await Promise.all([
    page.locator('#host .toolbar').boundingBox(),
    more.boundingBox(),
  ]);
  assert.ok(
    toolbar &&
      trigger &&
      trigger.y >= toolbar.y &&
      trigger.y + trigger.height <= toolbar.y + toolbar.height,
  );
  assert.equal(
    await page.locator('#other [data-floe-ui=more]').isVisible(),
    false,
  );
  await more.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'More browser actions' });
  await menu.waitFor();
  assert.equal(
    await page
      .getByRole('menuitem', { name: 'Choose source', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  assert.equal(await menu.locator('img').count(), 0);
  const rect = await menu.boundingBox();
  assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 480);
  await page.keyboard.press('End');
  assert.equal(
    await page
      .getByRole('menuitem', { name: 'Open window', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await more.evaluate((e) => e === document.activeElement), true);
  await more.click();
  await page
    .getByRole('menuitem', { name: 'Choose source', exact: true })
    .click();
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [true]);
  assert.equal(await menu.isVisible(), false);
  await more.click();
  await page.locator('#outside').click();
  assert.equal(await menu.isVisible(), false);
  await more.click();
  await page
    .getByRole('menuitem', { name: 'Open window', exact: true })
    .click();
  await more.click();
  assert.equal(
    await page
      .getByRole('menuitem', { name: 'Open window', exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() =>
    (window as any).rejectAction(new Error('Host error')),
  );
  await page.getByText('Window unavailable', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).failures), 1);
  await page.keyboard.press('Escape');
  await more.click();
  await page
    .getByRole('menuitem', { name: 'Open window', exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).view.destroy();
    (window as any).rejectAction(new Error('Late host error'));
  });
  assert.equal(await page.locator('#host').innerHTML(), '');
  assert.deepEqual(errors, []);
});
