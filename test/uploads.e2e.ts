import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { BrowserProjection } from '../dist/host/engine.js';
import type {
  ServerMessage,
  FileChooserState,
} from '../src/shared/protocol.js';

async function* data(value: string) {
  yield Buffer.from(value);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until<T>(get: () => T | undefined): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = get();
    if (value) return value;
    await tick();
  }
  throw new Error('Expected source file event');
}

test(
  'source file selection is private, one-shot, canceled on revocation and retained for later native reads',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const source = await browser.newPage();
    await source.goto(
      'data:text/html,<input type=file accept=".txt" multiple><output></output>',
    );
    const engine = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    t.after(() => engine.close());
    const observed: ServerMessage[] = [];
    const observer = await engine.observe((m) => observed.push(m));
    t.after(() => observer.close());
    const messages: ServerMessage[] = [];
    let choice: FileChooserState | undefined;
    const controller = await engine.connect((message) => {
      messages.push(message);
      if (message.type === 'file_chooser')
        choice = message.chooser ?? undefined;
    });
    await source.locator('input').click();
    const state = await until(() => choice);
    assert.equal(state.multiple, true);
    assert.equal(state.accept, '.txt');
    assert.equal(
      observed.some((m) => m.type === 'file_chooser'),
      false,
    );
    const file = await controller.upload(
      state.id,
      { name: 'input.txt', size: 5 },
      data('hello'),
    );
    const reply = (id: number, files: string[] | null) =>
      controller.receive({
        type: 'command',
        id,
        tab: engine.id,
        epoch: '',
        action: { kind: 'file_reply', chooser: state.id, files },
      });
    await reply(1, [file]);
    assert.ok(messages.some((m) => m.type === 'ack' && m.id === 1 && m.ok));
    assert.equal(
      await source
        .locator('input')
        .evaluate((node: HTMLInputElement) => node.files?.[0]?.name),
      'input.txt',
    );
    await reply(2, [file]);
    assert.ok(messages.some((m) => m.type === 'ack' && m.id === 2 && !m.ok));
    await source.locator('input').click();
    const second = await until(() =>
      choice && choice.id !== state.id ? choice : undefined,
    );
    await controller.close();
    await assert.rejects(
      controller.upload(second.id, { name: 'denied', size: 1 }, data('x')),
    );
    assert.equal(
      await source
        .locator('input')
        .evaluate(async (node: HTMLInputElement) => node.files![0]!.text()),
      'hello',
    );
  },
);

test(
  'directory selection preserves webkitRelativePath and source change events',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const source = await browser.newPage();
    await source.goto(
      'data:text/html,<input type=file webkitdirectory onchange="window.changes=(window.changes||0)+1">',
    );
    const engine = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    t.after(() => engine.close());
    let choice: FileChooserState | undefined;
    const messages: ServerMessage[] = [];
    const controller = await engine.connect((m) => {
      messages.push(m);
      if (m.type === 'file_chooser') choice = m.chooser ?? undefined;
    });
    await source.locator('input').click();
    const state = await until(() => choice);
    assert.equal(state.directory, true);
    const ids = [];
    for (const relativePath of ['folder/a.txt', 'folder/nested/b.txt'])
      ids.push(
        await controller.upload(
          state.id,
          { name: relativePath.split('/').at(-1)!, size: 1, relativePath },
          data('x'),
        ),
      );
    await controller.receive({
      type: 'command',
      id: 1,
      tab: engine.id,
      epoch: '',
      action: { kind: 'file_reply', chooser: state.id, files: ids },
    });
    assert.ok(messages.some((m) => m.type === 'ack' && m.ok));
    assert.deepEqual(
      await source
        .locator('input')
        .evaluate((node: HTMLInputElement) =>
          [...node.files!].map((file) => file.webkitRelativePath).sort(),
        ),
      ['folder/a.txt', 'folder/nested/b.txt'],
    );
    assert.equal(await source.evaluate(() => (window as any).changes), 1);
  },
);

test(
  'the reusable browser uploads through its carrier from visible and hidden cross-origin file inputs',
  { timeout: 20000 },
  async (t) => {
    const { createProjectionServer } = await import('../dist/host/server.js');
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.route('http://upload.test/', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><title>Upload source</title>
    <input id="upload" type="file" multiple accept=".txt" onchange="window.changes=(window.changes||0)+1; Promise.all([...this.files].map(f=>f.text())).then(v=>document.querySelector('output').textContent=v.join('|'))"><output></output>
    <iframe src="http://child.test/upload"></iframe>`,
      }),
    );
    await context.route('http://child.test/upload', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
    <input id="hidden" type="file" hidden onchange="this.files[0].text().then(v=>document.querySelector('output').textContent=v)">
    <button onclick="document.querySelector('input').click()">Attach file</button><output></output>`,
      }),
    );
    const source = await context.newPage();
    await source.goto('http://upload.test/');
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(5000);
    await viewer.route('**/*', (route) =>
      new URL(route.request().url()).origin === new URL(service.url).origin
        ? route.continue()
        : route.abort(),
    );
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const content = viewer.frameLocator('#viewport iframe');
    await clickProjected(content.locator('#upload'));
    const dialog = viewer.getByRole('dialog', {
      name: 'Choose files for this website',
      exact: true,
    });
    await dialog.waitFor();
    await mkdir('.test-artifacts', { recursive: true });
    await viewer.screenshot({ path: '.test-artifacts/file-picker.png' });
    const picker = viewer.waitForEvent('filechooser');
    await dialog
      .getByRole('button', { name: 'Choose files', exact: true })
      .click();
    await (
      await picker
    ).setFiles([
      { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
      { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('二') },
    ]);
    await source.waitForFunction(
      () => document.querySelector('output')?.textContent === 'one|二',
    );
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await source.evaluate(() => (window as any).changes), 1);
    await clickProjected(
      content
        .frameLocator('iframe')
        .getByRole('button', { name: 'Attach file' }),
    );
    await dialog.waitFor();
    assert.ok((await dialog.textContent())?.includes('child.test'));
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'child.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('child content'),
    });
    await source
      .frame({ url: 'http://child.test/upload' })!
      .waitForFunction(
        () => document.querySelector('output')?.textContent === 'child content',
      );
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);

test(
  'navigation rejects a staged selection and disconnected control cancels a stalled upload without replay',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const source = await browser.newPage();
    await source.goto('data:text/html,<input type=file>');
    const engine = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    t.after(() => engine.close());
    let choice: FileChooserState | undefined;
    const messages: ServerMessage[] = [];
    const controller = await engine.connect((m) => {
      messages.push(m);
      if (m.type === 'file_chooser') choice = m.chooser ?? undefined;
    });
    await source.locator('input').click();
    const state = await until(() => choice);
    const id = await controller.upload(
      state.id,
      { name: 'a', size: 1 },
      data('x'),
    );
    await source.goto('data:text/html,<input type=file id=new>');
    await controller.receive({
      type: 'command',
      id: 1,
      tab: engine.id,
      epoch: '',
      action: { kind: 'file_reply', chooser: state.id, files: [id] },
    });
    assert.ok(messages.some((m) => m.type === 'ack' && m.id === 1 && !m.ok));
    assert.equal(
      await source
        .locator('input')
        .evaluate((node: HTMLInputElement) => node.files!.length),
      0,
    );
    await source.locator('input').click();
    const next = await until(() =>
      choice && choice.id !== state.id ? choice : undefined,
    );
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        };
      },
    };
    const writing = controller.upload(next.id, { name: 'a', size: 1 }, body);
    const rejected = assert.rejects(writing);
    await controller.close();
    await rejected;
  },
);

test(
  'accepted upload storage belongs to the source document across projection recreation',
  { timeout: 15000 },
  async (t) => {
    const { PlaywrightSourceBrowser } =
      await import('../dist/host/playwright-source.js');
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto('data:text/html,<input type=file>');
    const owner = new PlaywrightSourceBrowser();
    t.after(() => owner.dispose());
    const source = await owner.adopt(page);
    let engine = await BrowserProjection.attach(source, {
      authorize: () => true,
      uploadLimits: { bytes: 1, files: 1 },
    });
    t.after(() => engine.close());
    let choice: FileChooserState | undefined;
    const listener = (m: ServerMessage) => {
      if (m.type === 'file_chooser') choice = m.chooser ?? undefined;
    };
    let control = await engine.connect(listener);
    await page.locator('input').click();
    const first = await until(() => choice);
    const id = await control.upload(
      first.id,
      { name: 'a', size: 1 },
      data('x'),
    );
    await control.receive({
      type: 'command',
      id: 1,
      tab: engine.id,
      epoch: '',
      action: { kind: 'file_reply', chooser: first.id, files: [id] },
    });
    await engine.close();
    assert.equal(
      await page
        .locator('input')
        .evaluate((node: HTMLInputElement) => node.files![0]!.text()),
      'x',
    );
    engine = await BrowserProjection.attach(source, { authorize: () => true });
    control = await engine.connect(listener);
    await page.locator('input').click();
    const second = await until(() =>
      choice && choice.id !== first.id ? choice : undefined,
    );
    assert.equal(second.maxBytes, 0);
    await assert.rejects(
      control.upload(second.id, { name: 'b', size: 1 }, data('y')),
    );
    await page.goto('data:text/html,<input type=file id=fresh>');
    await page.locator('input').click();
    const third = await until(() =>
      choice && choice.id !== second.id ? choice : undefined,
    );
    await control.upload(third.id, { name: 'c', size: 1 }, data('z'));
  },
);
