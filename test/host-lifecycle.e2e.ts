import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import {
  BrowserSession,
  BrowserProjection,
  PlaywrightSourceBrowser,
} from '../dist/host/index.js';
import { createProjectionServer } from '../dist/host/server.js';
import type { ServerMessage } from '../src/shared/protocol.js';

async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), 'Expected host lifecycle event did not arrive');
}

test(
  'a failed input drain attempts every release and remains a visible terminal barrier',
  { timeout: 10000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto('data:text/html,<input>');
    const owner = new PlaywrightSourceBrowser();
    const source = await owner.adopt(page, 'drain');
    const projection = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await projection.close().catch(() => {});
      await owner.dispose();
    });
    const messages: ServerMessage[] = [];
    const observation = await projection.observe(
      (message) => messages.push(message),
      { media: false },
    );
    const control = await projection.acquireControl(observation, () => true);
    await wait(() => messages.some((message) => message.type === 'snapshot'));
    const epoch = messages.findLast(
      (message) => message.type === 'snapshot',
    )!.epoch;
    for (const [index, key] of ['Shift', 'Control'].entries())
      await control.receive({
        type: 'command',
        id: index + 1,
        tab: source.id,
        epoch,
        action: {
          kind: 'key',
          phase: 'down',
          key,
          code: `${key}Left`,
          modifiers: 0,
        },
      });
    const send = source.transport.send.bind(source.transport),
      released: string[] = [];
    source.transport.send = async (method, parameters) => {
      if (method === 'Input.dispatchKeyEvent' && parameters.type === 'keyUp') {
        released.push(parameters.key);
        if (parameters.key === 'Shift')
          throw new Error('Fixture release failure');
      }
      return send(method, parameters);
    };
    await assert.rejects(control.close(), /release|drain/i);
    assert.deepEqual(released, ['Shift', 'Control']);
    await assert.rejects(control.close(), /release|drain/i);
    await assert.rejects(projection.acquireControl(observation, () => true));
    await assert.rejects(observation.close(), /release|drain/i);
    await assert.rejects(projection.close(), /release|drain/i);
    source.transport.send = send;
  },
);

for (const mode of ['visible', 'hidden', 'reselected-close', 'engine-close'])
  test(
    `revoking control cancels its pending navigation before draining input: ${mode}`,
    { timeout: 10000 },
    async (t) => {
      const server = http.createServer((_request, _response) => {});
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const context = await browser.newContext();
      const page = await context.newPage();
      const session = await BrowserSession.attach(page, {
        authorize: () => true,
      });
      t.after(() => session.close());
      const view = await session.connect(() => {});
      const original = view.currentState.active;
      const entered = once(server, 'request');
      const navigation = view.receive({
        type: 'command',
        id: 1,
        tab: view.currentState.active,
        epoch: '',
        action: {
          kind: 'navigate',
          url: `http://127.0.0.1:${(server.address() as any).port}`,
        },
      });
      await entered;
      if (mode === 'hidden' || mode === 'reselected-close') {
        await view.receive({
          type: 'command',
          id: 2,
          tab: view.currentState.active,
          epoch: '',
          action: { kind: 'tab_new' },
        });
        assert.equal(view.currentState.tabs.length, 2);
      }
      if (mode === 'reselected-close') {
        await view.receive({
          type: 'command',
          id: 3,
          tab: view.currentState.active,
          epoch: '',
          action: { kind: 'tab_select', tab: original },
        });
      }
      const closing =
        mode === 'reselected-close'
          ? view.close()
          : mode === 'engine-close'
            ? (await session.projection(original)).close()
            : view.releaseControl();
      await Promise.race([
        closing,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Input drain waited for navigation')),
            1000,
          ),
        ),
      ]);
      await navigation;
    },
  );

test(
  'directory-only closing confirms beforeunload without granting page input and rejects another observer',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(
      'data:text/html,<button onclick="window.onbeforeunload=()=>true">Protect</button>',
    );
    const session = await BrowserSession.attach(page, {
      authorize: () => false,
    });
    t.after(() => session.close());
    await page.getByRole('button').click();
    const messages: ServerMessage[] = [],
      other: ServerMessage[] = [];
    const view = await session.observe((message) => messages.push(message), {
      media: false,
    });
    const watcher = await session.observe((message) => other.push(message), {
      media: false,
    });
    view.setDirectoryAuthority(() => true);
    const target = view.currentState.active;
    const close = view.receive({
      type: 'command',
      id: 1,
      tab: target,
      epoch: '',
      action: { kind: 'tab_close', tab: target },
    });
    await wait(() =>
      messages.some(
        (message) => message.type === 'dialog' && message.dialog !== null,
      ),
    );
    const dialog = messages.findLast((message) => message.type === 'dialog')!;
    assert.equal((await session.projection(target)).hasController, false);
    assert.equal(
      other.some(
        (message) => message.type === 'dialog' && message.dialog !== null,
      ),
      false,
    );
    await watcher.receive({
      type: 'command',
      id: 1,
      tab: target,
      epoch: '',
      action: { kind: 'dialog_reply', dialog: dialog.dialog!.id, accept: true },
    });
    assert.equal(
      other.findLast((message) => message.type === 'ack')?.code,
      'not_allowed',
    );
    assert.equal(
      await watcher.receiveDirectoryDecision({
        type: 'command',
        id: 2,
        tab: target,
        epoch: '',
        action: {
          kind: 'dialog_reply',
          dialog: dialog.dialog!.id,
          accept: true,
        },
      }),
      false,
    );
    assert.equal(
      await view.receiveDirectoryDecision({
        type: 'command',
        id: 2,
        tab: target,
        epoch: '',
        action: {
          kind: 'dialog_reply',
          dialog: dialog.dialog!.id,
          accept: false,
        },
      }),
      true,
    );
    await close;
    assert.equal(page.isClosed(), false);
    assert.equal(view.currentState.tabs.length, 1);
    messages.length = 0;
    const closing = view.receive({
      type: 'command',
      id: 3,
      tab: target,
      epoch: '',
      action: { kind: 'tab_close', tab: target },
    });
    await wait(() =>
      messages.some(
        (message) => message.type === 'dialog' && message.dialog !== null,
      ),
    );
    view.setDirectoryAuthority(undefined);
    await closing;
    assert.equal(
      page.isClosed(),
      false,
      'Revoking directory authority cancels the pending close decision',
    );
    view.setDirectoryAuthority(() => true);
    await view.receive({
      type: 'command',
      id: 4,
      tab: target,
      epoch: '',
      action: { kind: 'tab_new' },
    });
    const otherTarget = view.currentState.active;
    assert.notEqual(otherTarget, target);
    messages.length = 0;
    const backgroundClose = view.receive({
      type: 'command',
      id: 5,
      tab: otherTarget,
      epoch: '',
      action: { kind: 'tab_close', tab: target },
    });
    await wait(() =>
      messages.some(
        (message) => message.type === 'dialog' && message.dialog !== null,
      ),
    );
    assert.equal(
      view.currentState.active,
      target,
      'A background close decision selects its own source before presentation',
    );
    const finalDialog = messages.findLast(
      (message) => message.type === 'dialog',
    )!;
    await view.receiveDirectoryDecision({
      type: 'command',
      id: 6,
      tab: target,
      epoch: '',
      action: {
        kind: 'dialog_reply',
        dialog: finalDialog.dialog!.id,
        accept: true,
      },
    });
    await backgroundClose;
    assert.equal(page.isClosed(), true);
    assert.equal(view.currentState.active, otherTarget);
  },
);

test(
  'browser chrome replies to its directory decision while page input stays disabled',
  { timeout: 10000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
    import { mountBrowser } from './src/viewer/index.js';
    import { PROTOCOL_VERSION } from './src/shared/protocol.js';
    window.sent=[]; window.control=[];
    mountBrowser(document.body, { onControl: active => window.control.push(active), connect: () => ({
      send: message => window.sent.push(message),
      close() {}, onDisconnect: () => () => {},
      subscribe(listener) {
        window.deliver = listener;
        queueMicrotask(() => {
          listener({type:'hello',version:PROTOCOL_VERSION,mediaWireVersion:1});
          listener({type:'tabs',state:{active:'source',tabs:[{id:'source',url:'about:blank',title:'Source'}]}});
          listener({type:'session_access',editTabs:true});
          listener({type:'control',target:'source',active:false});
          listener({type:'dialog',target:'source',dialog:{id:'decision',type:'beforeunload',authority:'directory',url:'https://source.example',message:'',defaultPrompt:'',truncated:false}});
        });
        return () => {};
      }
    }) });
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
    page.on('pageerror', (error) => t.diagnostic(error.message));
    await page.route('http://127.0.0.1/component', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><body></body></html>',
      }),
    );
    await page.goto('http://127.0.0.1/component');
    await page.addStyleTag({
      content: await readFile('src/viewer/style.css', 'utf8'),
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('button', { name: 'Leave page', exact: true })
      .click();
    await page.waitForFunction(() =>
      (window as any).sent.some(
        (message: any) => message.action?.kind === 'dialog_reply',
      ),
    );
    assert.equal(
      await page.evaluate(() => (window as any).control.includes(true)),
      false,
    );
    assert.deepEqual(
      await page.evaluate(() =>
        (window as any).sent.map((message: any) => message.action?.kind),
      ),
      ['dialog_reply'],
    );
  },
);

test(
  'a failed source drain still closes standalone carriers and retains the rejection',
  { timeout: 10000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const source = await browser.newPage();
    await source.goto('data:text/html,<input>');
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close().catch(() => {}));
    const viewer = await browser.newPage();
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    (service.engine as any).releaseInput = async () => {
      throw new Error('Fixture input cleanup failure');
    };
    const closing = service.close();
    await assert.rejects(closing, /cleanup/i);
    assert.equal(
      service.close(),
      closing,
      'Repeated closure retains the same drain result',
    );
    await assert.rejects(
      fetch(service.url, { signal: AbortSignal.timeout(1000) }),
    );
  },
);
