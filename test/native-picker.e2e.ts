import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

test('native file selection is automatic, scoped and canceled before stale replies can reach the source', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { mountBrowser } from './src/viewer/index.js';
        import { PROTOCOL_VERSION } from './src/shared/protocol.js';
        window.sent=[]; window.pickers=[];
        const connection = {
          send(message) {
            window.sent.push(message);
            if (message.type==='command') queueMicrotask(()=>window.deliver({type:'ack',id:message.id,ok:true}));
          },
          subscribe(listener) {
            window.deliver=listener;
            queueMicrotask(()=> {
              listener({type:'hello',version:PROTOCOL_VERSION,mediaWireVersion:1});
              listener({type:'tabs',state:{active:'source',tabs:[{id:'source',title:'Source',url:'https://source.test/'}]}});
              listener({type:'control',target:'source',active:true});
            });
            return ()=>{};
          },
          onDisconnect(listener) {window.disconnect=listener;return ()=>{};}, close() {}
        };
        window.browser=mountBrowser(document.querySelector('main'),{
          connect:()=>connection,
          chooseFiles:(request,context)=>new Promise((resolve,reject)=>window.pickers.push({request,...context,resolve,reject}))
        });
        window.choose=id=>window.deliver({type:'file_chooser',target:'source',chooser:{id,target:'source',url:'https://upload.test/',multiple:true,directory:false,accept:'.txt',maxBytes:1024,maxFiles:3}});
      `,
    },
    bundle: true,
    format: 'iife',
    write: false,
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(2500);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://127.0.0.1/picker', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<main style="height:700px"></main>',
    }),
  );
  await page.goto('http://127.0.0.1/picker');
  await page.addStyleTag({
    content: await readFile('src/viewer/style.css', 'utf8'),
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.getByRole('tab', { name: 'Source', exact: true }).waitFor();
  const choose = (id: string) =>
    page.evaluate((id) => (window as any).choose(id), id);
  const pickers = (count: number) =>
    page.waitForFunction(
      (count) => (window as any).pickers.length === count,
      count,
    );
  const replies = () =>
    page.evaluate(() =>
      (window as any).sent.filter((m: any) => m.action?.kind === 'file_reply'),
    );
  await choose('first');
  await pickers(1);
  await choose('first');
  assert.equal(await page.evaluate(() => (window as any).pickers.length), 1);
  assert.equal(
    await page.evaluate(() => (window as any).pickers[0].request.url),
    'https://upload.test/',
  );
  await page.evaluate(() =>
    (window as any).pickers[0].progress({ current: 1, total: 2 }),
  );
  const dialog = page.getByRole('dialog', {
    name: 'Choose files for this website',
    exact: true,
  });
  assert.match((await dialog.textContent()) ?? '', /1.*2/);
  await page.evaluate(() =>
    (window as any).pickers[0].resolve(['a'.repeat(32)]),
  );
  await page.waitForFunction(() =>
    (window as any).sent.some(
      (m: any) => m.action?.files?.[0] === 'a'.repeat(32),
    ),
  );
  assert.equal((await replies()).length, 1);

  // A chooser in a replacement document retires both selection and transfer.
  await choose('old-document');
  await pickers(2);
  await choose('new-document');
  await pickers(3);
  assert.equal(
    await page.evaluate(() => (window as any).pickers[1].signal.aborted),
    true,
  );
  await page.evaluate(() => {
    (window as any).pickers[1].resolve(['b'.repeat(32)]);
    (window as any).pickers[1].progress({ current: 2, total: 2 });
    (window as any).pickers[2].resolve(null);
  });
  await page.waitForFunction(() =>
    (window as any).sent.some((m: any) => m.action?.chooser === 'new-document'),
  );
  assert.deepEqual(
    (await replies()).map((m: any) => [m.action.chooser, m.action.files]),
    [
      ['first', ['a'.repeat(32)]],
      ['new-document', null],
    ],
  );

  await choose('canceled');
  await pickers(4);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(
    await page.evaluate(() => (window as any).pickers[3].signal.aborted),
    true,
  );
  await page.evaluate(() =>
    (window as any).pickers[3].resolve(['c'.repeat(32)]),
  );
  assert.deepEqual((await replies()).at(-1).action, {
    kind: 'file_reply',
    chooser: 'canceled',
    files: null,
  });

  await choose('revoked');
  await pickers(5);
  await page.evaluate(() => {
    (window as any).deliver({
      type: 'control',
      target: 'source',
      active: false,
    });
    (window as any).pickers[4].resolve(['d'.repeat(32)]);
  });
  assert.equal(
    await page.evaluate(() => (window as any).pickers[4].signal.aborted),
    true,
  );
  assert.equal((await replies()).length, 3);
  await page.evaluate(() =>
    (window as any).deliver({
      type: 'control',
      target: 'source',
      active: true,
    }),
  );
  await choose('invalid-path');
  await pickers(6);
  await page.evaluate(() =>
    (window as any).pickers[5].resolve(['/private/file.txt']),
  );
  await dialog.getByRole('status').filter({ hasText: 'could not' }).waitFor();
  assert.equal(
    (await replies()).length,
    3,
    'Filesystem paths never enter the source command carrier',
  );
  await choose('disconnected');
  await pickers(7);
  await page.evaluate(() => {
    (window as any).disconnect();
    (window as any).pickers[6].resolve(['e'.repeat(32)]);
  });
  assert.equal(
    await page.evaluate(() => (window as any).pickers[6].signal.aborted),
    true,
  );
  assert.equal((await replies()).length, 3);
  await page.evaluate(() => (window as any).browser.reconnect());
  await choose('destroyed');
  await pickers(8);
  await page.evaluate(() => {
    (window as any).browser.destroy();
    (window as any).pickers[7].resolve(['f'.repeat(32)]);
  });
  assert.equal(
    await page.evaluate(() => (window as any).pickers[7].signal.aborted),
    true,
  );
  assert.equal((await replies()).length, 3);
  assert.deepEqual(errors, []);
});
