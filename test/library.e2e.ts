import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

test('host library saves the current page, searches locally and never renders stale results', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { mountBrowser } from './src/viewer/index.js';
    import { PROTOCOL_VERSION } from './src/shared/protocol.js';
    window.calls=[]; window.reads=[];
    let receive;
    window.view=mountBrowser(document.body, {
      connect:()=>({send(message){window.calls.push(message);if(message.type==='command')queueMicrotask(()=>receive({type:'ack',id:message.id,ok:true}));},
      subscribe(fn){receive=fn;window.receive=fn;queueMicrotask(()=>{
        fn({type:'hello',version:PROTOCOL_VERSION,mediaWireVersion:1});
        fn({type:'tabs',state:{active:'source',tabs:[{id:'source',url:'https://site.test/page',title:'Project'}]}});
        fn({type:'control',target:'source',active:true});
        fn({type:'state',state:{id:'source',url:'https://site.test/page',title:'Project',zoom:1,loading:false,canGoBack:false,canGoForward:false}});
      });return()=>{};},onDisconnect(){return()=>{};},close(){}}),
      library:{
        list(kind,query,signal){return new Promise(resolve=>window.reads.push({kind,query,signal,resolve}));},
        saveBookmark(entry){window.calls.push({save:entry});return Promise.resolve();},
        removeBookmark(url){window.calls.push({remove:url});return Promise.resolve();},
        clearHistory(){window.calls.push({clear:true});return Promise.resolve();}
      }
    });`,
    },
    bundle: true,
    format: 'iife',
    write: false,
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.route('http://127.0.0.1/library', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>' }),
  );
  await page.goto('http://127.0.0.1/library');
  await page.addStyleTag({
    content: await readFile('src/viewer/style.css', 'utf8'),
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page
    .getByRole('button', { name: 'Bookmarks and history', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Bookmark this page', exact: true })
    .click();
  await page.waitForFunction(() =>
    (window as any).calls.some(
      (call: any) => call.save?.url === 'https://site.test/page',
    ),
  );
  assert.deepEqual(
    await page.evaluate(
      () => (window as any).calls.find((call: any) => call.save).save,
    ),
    { url: 'https://site.test/page', title: 'Project' },
  );
  await page
    .getByRole('searchbox', { name: 'Search bookmarks and history' })
    .fill('alpha');
  await page
    .getByRole('searchbox', { name: 'Search bookmarks and history' })
    .fill('beta');
  await page.evaluate(() => {
    (window as any).reads
      .findLast((read: any) => read.query === 'beta')
      .resolve([
        { url: 'https://beta.test/', title: '<img src=x>' },
        { url: 'javascript:alert(1)', title: 'Unsafe' },
      ]);
  });
  await page
    .getByRole('button', {
      name: '<img src=x> https://beta.test/',
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator('.browser-library img').count(), 0);
  assert.equal(await page.getByText('Unsafe', { exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).reads.findLast((read: any) => read.query === 'alpha')
          .signal.aborted,
    ),
    true,
  );
  await page.evaluate(() =>
    (window as any).reads
      .findLast((read: any) => read.query === 'alpha')
      .resolve([{ url: 'https://stale.test/', title: 'Stale result' }]),
  );
  assert.equal(await page.getByText('Stale result').count(), 0);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page
    .getByRole('button', { name: 'Clear browsing history', exact: true })
    .click();
  assert.equal(
    await page.evaluate(() =>
      (window as any).calls.some((call: any) => call.clear),
    ),
    false,
  );
  await page
    .getByRole('button', { name: 'Confirm clearing history', exact: true })
    .click();
  await page.waitForFunction(() =>
    (window as any).calls.some((call: any) => call.clear),
  );
  await page
    .getByRole('button', { name: 'Close library', exact: true })
    .click();
  assert.equal(await page.locator('.browser-library').isVisible(), false);
  await page.evaluate(() => (window as any).view.destroy());
  assert.equal(await page.locator('.browser-library').count(), 0);
});
