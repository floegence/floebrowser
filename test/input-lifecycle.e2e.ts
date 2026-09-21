import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { clickProjected } from './projected-input.js';

for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} cancels obsolete composition and releases source input when focus leaves`,
    { timeout: 20000 },
    async (t) => {
      const sourceBrowser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() =>
        Promise.all([sourceBrowser.close(), viewerBrowser.close()]),
      );
      const source = await sourceBrowser.newPage();
      source.setDefaultTimeout(4000);
      await source.route('http://input.test/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><title>Input lifecycle</title><input aria-label="Source field"><button onclick="window.clicks++">Action</button><div contenteditable>Editable</div><script>window.clicks=0;window.shift=false;window.pressed=false;addEventListener('keydown',e=>{if(e.key==='Shift')window.shift=true});addEventListener('keyup',e=>{if(e.key==='Shift')window.shift=false});addEventListener('mousedown',()=>window.pressed=true);addEventListener('mouseup',()=>window.pressed=false);</script>`,
        }),
      );
      await source.goto('http://input.test/');
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(() => service.close());
      const viewer = await viewerBrowser.newPage();
      viewer.setDefaultTimeout(4000);
      const commands: any[] = [];
      const pending = new Set<number>();
      viewer.on('websocket', (socket) => {
        socket.on('framesent', ({ payload }) => {
          if (typeof payload !== 'string') return;
          const message = JSON.parse(payload);
          if (message.type === 'command') {
            commands.push(message.action);
            pending.add(message.id);
          }
        });
        socket.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string') return;
          const message = JSON.parse(payload);
          if (message.type === 'ack') pending.delete(message.id);
        });
      });
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const content = viewer.frameLocator('#viewport iframe');
      await clickProjected(content.locator('input'));
      await source.waitForFunction(
        () => document.activeElement?.tagName === 'INPUT',
      );
      await viewer.keyboard.down('Shift');
      await source.waitForFunction(() => (window as any).shift);
      await viewer.locator('#address').click();
      await source.waitForFunction(() => !(window as any).shift);
      await viewer.keyboard.up('Shift');
      await viewer.keyboard.press('Escape');
      assert.ok(commands.some((action) => action.kind === 'release_input'));
      const button = await content.locator('button').boundingBox();
      await viewer.mouse.move(button!.x + 10, button!.y + 10);
      await viewer.mouse.down();
      await source.waitForFunction(() => (window as any).pressed);
      await viewer.mouse.move(10, 5);
      await viewer.mouse.up();
      await source.waitForFunction(() => !(window as any).pressed);
      assert.equal(
        await source.evaluate(() => (window as any).clicks),
        0,
        'Releasing outside content does not synthesize a click on the old target',
      );

      // Contenteditable uses the host IME sink, which survives document switches.
      await clickProjected(content.locator('[data-floebrowser-editable]'));
      await viewer
        .locator('.floe-input-sink')
        .dispatchEvent('compositionstart', { data: '' });
      // Navigation here tests IME cancellation, not the separately tested unknown
      // result of interrupting a source click before its acknowledgement.
      const deadline = Date.now() + 4000;
      while (pending.size && Date.now() < deadline)
        await viewer.waitForTimeout(10);
      assert.equal(pending.size, 0);
      await source.goto('http://input.test/next');
      await viewer.waitForFunction(() =>
        (
          document.querySelector<HTMLInputElement>('#address')?.value ?? ''
        ).endsWith('/next'),
      );
      await clickProjected(content.locator('input'));
      await source.waitForFunction(
        () => document.activeElement?.tagName === 'INPUT',
      );
      await viewer.locator('.floe-input-sink').evaluate((sink) => {
        sink.dispatchEvent(
          new CompositionEvent('compositionend', {
            data: 'old composition',
            bubbles: true,
          }),
        );
        sink.dispatchEvent(
          new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: 'old composition',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await viewer.keyboard.type('fresh');
      await source.waitForFunction(
        () => document.querySelector('input')!.value === 'fresh',
      );
      assert.equal(
        commands.some(
          (action) =>
            action.kind === 'text' && action.text === 'old composition',
        ),
        false,
      );
      assert.equal(
        await viewer.locator('#toast').isVisible(),
        false,
        JSON.stringify({
          toast: await viewer.locator('#toast').textContent(),
          commands,
        }),
      );
    },
  );
