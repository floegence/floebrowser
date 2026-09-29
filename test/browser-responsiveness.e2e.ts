import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

test('latest selection and unrelated close dispatch without an old ACK; cold previews never show another target', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { mountBrowser } from './src/viewer/index.js';
    import { ReplayPages } from './src/viewer/replay-pages.js';
    import { PROTOCOL_VERSION } from './src/shared/protocol.js';
    window.sent = []; window.traces = []; window.results = {}; let receive;
    window.feed = m => receive(m);
    window.view = mountBrowser(document.querySelector('#viewer'), { onTrace: event => window.traces.push(event), connect: () => ({
      subscribe: fn => { receive = fn; return () => {}; }, onDisconnect: () => () => {}, close() {},
      send: m => window.sent.push({ ...m, at: performance.now() }),
    }) });
    window.feed({ type: 'hello', version: PROTOCOL_VERSION, mediaWireVersion: 1 });
    window.tabs = active => ({ type: 'tabs', state: { active, tabs: ['a','b','c'].map(id => ({ id, title: 'Page '+id, url:'https://'+id+'.test/' })) } });
    window.feed(window.tabs('a'));
    window.cache = new ReplayPages(document.querySelector('#cache'));
    const surface = window.cache.create(); surface.textContent = 'Page a contents';
    window.cache.present(surface); window.cache.retain('a', 'https://a.test/', surface, () => {});
  `,
    },
    bundle: true,
    format: 'iife',
    write: false,
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => t.diagnostic(error.message));
  await page.route('http://127.0.0.1/fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="viewer" style="height:600px"></div><div id="cache" style="position:relative;width:600px;height:100px"></div>',
    }),
  );
  await page.goto('http://127.0.0.1/fixture');
  await page.addStyleTag({
    content: await readFile('src/viewer/style.css', 'utf8'),
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.getByRole('tab', { name: 'Page b', exact: true }).waitFor();
  const selected = await page.evaluate(() => {
    const w = window as any,
      started = performance.now();
    document.querySelector<HTMLButtonElement>('[data-tab="b"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-tab="c"]')!.click();
    return {
      started,
      sent: w.sent,
      selected: document
        .querySelector('[aria-selected="true"]')
        ?.getAttribute('data-tab'),
    };
  });
  assert.deepEqual(
    selected.sent
      .filter((m: any) => m.type === 'command')
      .map((m: any) => m.action.tab),
    ['b', 'c'],
  );
  assert.equal(selected.selected, 'c');
  assert(
    selected.sent.at(-1).at - selected.started <= 100,
    'Idle dispatch budget excludes automation and waits',
  );
  const outcome = await page.evaluate(async () => {
    const w = window as any;
    w.feed(w.tabs('c'));
    w.feed({ type: 'ack', id: w.sent[1].id, ok: true });
    w.feed({ type: 'ack', id: w.sent[0].id, ok: false, code: 'action_failed' });
    await Promise.resolve();
    w.view.dispatch({ kind: 'tab_retry', tab: 'c' });
    w.view.dispatch({ kind: 'tab_retry', tab: 'c' });
    w.view.dispatch({ kind: 'tab_close', tab: 'b' });
    await Promise.resolve();
    return {
      kinds: w.sent.map((m: any) => m.action?.kind),
      acknowledgements: w.traces.filter((m: any) => m.stage === 'command_ack'),
      selected: document
        .querySelector('[aria-selected="true"]')
        ?.getAttribute('data-tab'),
    };
  });
  assert.equal(
    outcome.selected,
    'c',
    'A late failure must not revert current selection',
  );
  assert.deepEqual(outcome.kinds, [
    'tab_select',
    'tab_select',
    'tab_retry',
    'tab_close',
  ]);
  assert.deepEqual(
    outcome.acknowledgements.map((event: any) => [
      event.request,
      event.target,
      event.action,
    ]),
    [
      [2, 'c', 'tab_select'],
      [1, 'b', 'tab_select'],
    ],
    'Late replies retain their original target identity for diagnostics',
  );
  const preview = await page.evaluate(() => {
    const w = window as any;
    const missed = w.cache.preview('b');
    const cold = document.querySelector<HTMLElement>('#cache')!.innerText;
    const hit = w.cache.preview('a');
    const warm = document.querySelector<HTMLElement>('#cache')!.innerText;
    w.view.destroy();
    w.cache.destroy();
    return { missed, cold, hit, warm };
  });
  assert.equal(preview.missed, false);
  assert.equal(
    preview.cold,
    '',
    'A cold selection hides another target picture',
  );
  assert.equal(preview.hit, true);
  assert.equal(preview.warm, 'Page a contents');
});
