import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

for (const mismatch of ['projection', 'media', 'missing-media'])
  test(`an incompatible ${mismatch} handshake cannot admit input or revive the old connection`, async (t) => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
      import {mountBrowser} from './src/viewer/index.js';
      import {PROTOCOL_VERSION} from './src/shared/protocol.js';
      import {MEDIA_WIRE_VERSION} from './src/shared/media-wire.js';
      window.sent=[];window.closedConnections=[];window.updates=0;window.states=[];
      let generation=0;
      window.view=mountBrowser(document.querySelector('#host'), {
        onState: state=>window.states.push(state),
        onCheckForUpdates: ()=>{window.updates++},
        connect() {
          const id=generation++;
          return {
            send(message){window.sent.push(message);queueMicrotask(()=>window.deliver({type:'ack',id:message.id,ok:true}));},
            subscribe(listener){window.deliver=listener;queueMicrotask(()=>{
              listener({type:'hello',version:id||${JSON.stringify(mismatch)}!=='projection'?PROTOCOL_VERSION:PROTOCOL_VERSION+1,mediaWireVersion:id||${JSON.stringify(mismatch)}==='projection'?MEDIA_WIRE_VERSION:${JSON.stringify(mismatch)}==='missing-media'?undefined:MEDIA_WIRE_VERSION+1});
              listener({type:'tabs',state:{active:'target',tabs:[{id:'target',title:'Source',url:'about:blank'}]}});
              listener({type:'control',target:'target',active:true});
            });return()=>{};},
            onDisconnect(){return()=>{};},
            close(){window.closedConnections.push(id);}
          };
        }
      });
      window.validHello=()=>window.deliver({type:'hello',version:PROTOCOL_VERSION,mediaWireVersion:MEDIA_WIRE_VERSION});
    `,
      },
      bundle: true,
      format: 'iife',
      write: false,
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
      t.diagnostic(error.message);
    });
    await page.route('http://127.0.0.1/compatibility', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<div id="host" style="height:700px"></div>',
      }),
    );
    await page.goto('http://127.0.0.1/compatibility');
    await page.addStyleTag({
      content: await readFile('src/viewer/style.css', 'utf8'),
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.getByText('Browser update required', { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'New tab', exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).closedConnections),
      [0],
    );
    assert.equal(
      await page.evaluate(() =>
        (window as any).view.dispatch({ kind: 'tab_new' }),
      ),
      false,
    );
    await page.evaluate(() => {
      (window as any).validHello();
      (window as any).deliver({
        type: 'state',
        state: {
          id: 'target',
          url: 'https://stale.invalid',
          title: 'Late source',
        },
      });
    });
    assert.deepEqual(await page.evaluate(() => (window as any).states), []);
    assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
    await page
      .getByRole('button', { name: 'Check for updates', exact: true })
      .click();
    assert.equal(await page.evaluate(() => (window as any).updates), 1);
    assert.deepEqual(
      await page.evaluate(() => (window as any).closedConnections),
      [0],
      'Checking for updates does not replay or reconnect automatically',
    );
    await page.evaluate(() => (window as any).view.reconnect());
    await page.getByRole('tab', { name: 'Source', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).sent.length), 1);
    assert.deepEqual(errors, []);
  });
