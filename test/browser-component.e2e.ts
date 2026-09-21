import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

test('embedded browsers own their chrome, focus, localization and lifetime', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { mountBrowser, englishMessages } from './src/viewer/index.js';
        import { PROTOCOL_VERSION } from './src/shared/protocol.js';
        window.sent = [[], []]; window.closeCounts = [0, 0]; window.deliver=[]; window.takeovers=[];
        window.views = [0, 1].map(index => {
          let receiver;
          const connection = {
            send(message) {
              window.sent[index].push(message);
              if (message.type === 'command') queueMicrotask(() => receiver?.({ type: 'ack', id: message.id, ok: true }));
            },
            subscribe(listener) {
              receiver = listener; window.deliver[index]=listener;
              queueMicrotask(() => {
                receiver?.({type:'hello', version:PROTOCOL_VERSION, mediaWireVersion:1});
                receiver?.({type:'tabs', state:{active:'tab-'+index, tabs:[{id:'tab-'+index,title:'Page '+index,url:'about:blank'}]}});
                receiver?.({type:'control',target:'tab-'+index,active:true});
              });
              return () => { receiver = undefined; };
            },
            onDisconnect() { return () => {}; },
            close() { window.closeCounts[index]++; }
          };
          return mountBrowser(document.querySelector('#host-'+index), {
            connect: () => connection,
            messages: Object.fromEntries(Object.entries(englishMessages).map(([key, value]) => [key, index ? value : 'Localized ' + value])),
            onTakeControl: target => {window.takeovers.push(target);throw new Error('Denied by host');},
            title: index ? 'Second browser' : '<img src=x onerror=alert(1)>'
          });
        });`,
    },
    bundle: true,
    format: 'iife',
    write: false,
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    t.diagnostic(error.message);
  });
  await page.route('http://127.0.0.1/component', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Host title</title><button id="outside">Host button</button><div style="display:flex;height:700px"><section id="host-0" style="width:50%"></section><section id="host-1" style="width:50%"></section></div>',
    }),
  );
  await page.goto('http://127.0.0.1/component');
  await page.addStyleTag({
    content: await readFile('src/viewer/style.css', 'utf8'),
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const first = page.locator('#host-0'),
    second = page.locator('#host-1');
  await first.getByRole('tab', { name: 'Page 0', exact: true }).waitFor();
  await second.getByRole('tab', { name: 'Page 1', exact: true }).waitFor();
  await first
    .getByRole('button', { name: 'Localized New tab', exact: true })
    .click();
  await page.waitForFunction(() =>
    (window as any).sent[0].some((m: any) => m.action?.kind === 'tab_new'),
  );
  assert.equal(await page.evaluate(() => (window as any).sent[1].length), 0);
  assert.equal(
    await page.title(),
    'Host title',
    'Mounting never changes the embedding document title',
  );
  assert.equal(
    await first.locator('[data-floe-ui=browser-title]').textContent(),
    '<img src=x onerror=alert(1)>',
  );
  assert.equal(
    await first.locator('[data-floe-ui=browser-title] img').count(),
    0,
  );
  await second.getByRole('combobox').focus();
  await page.keyboard.press('Control+l');
  assert.equal(
    await second
      .getByRole('combobox')
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await first.getByRole('combobox').fill('Page');
  // The address combobox always references its own list, with unique IDs.
  const ids = await page
    .locator('[role=combobox]')
    .evaluateAll((elements) =>
      elements.map((e) => e.getAttribute('aria-controls')),
    );
  assert.equal(new Set(ids).size, 2);
  await page.locator('#outside').focus();
  await page.keyboard.press('Control+l');
  assert.equal(
    await page
      .locator('#outside')
      .evaluate((e) => e === document.activeElement),
    true,
    'Embedded shortcuts never steal host focus',
  );
  assert.equal(
    await page
      .locator('#outside')
      .evaluate((e) => getComputedStyle(e).borderRadius),
    '0px',
    'Browser styling does not change host buttons',
  );
  await page.evaluate(() =>
    (window as any).deliver[0]({
      type: 'control',
      target: 'tab-0',
      active: false,
    }),
  );
  assert.equal(
    await first
      .getByRole('combobox')
      .evaluate((e: HTMLInputElement) => e.readOnly),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      (window as any).views[0].dispatch({
        kind: 'navigate',
        url: 'https://must-not-open.invalid/',
      }),
    ),
    false,
  );
  await first
    .getByRole('button', { name: 'Localized Take control', exact: true })
    .click();
  await first
    .locator('[data-floe-ui=toast]')
    .filter({ hasText: 'Control could not be transferred' })
    .waitFor();
  assert.deepEqual(await page.evaluate(() => (window as any).takeovers), [
    'tab-0',
  ]);
  assert.equal(await second.locator('[data-floe-ui=toast]').isVisible(), false);
  await page.evaluate(() => {
    (window as any).views[0].destroy();
    (window as any).views[0].destroy();
  });
  assert.equal(await first.locator('*').count(), 0);
  await second.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.waitForFunction(() =>
    (window as any).sent[1].some((m: any) => m.action?.kind === 'tab_new'),
  );
  assert.deepEqual(
    await page.evaluate(() => (window as any).closeCounts),
    [1, 0],
  );
  await page.evaluate(() => (window as any).views[1].destroy());
  assert.deepEqual(
    await page.evaluate(() => (window as any).closeCounts),
    [1, 1],
  );
  assert.deepEqual(errors, []);
});
