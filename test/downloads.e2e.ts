import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'downloads execute with source credentials and save only on an explicit client gesture',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'source-only', value: 'private', url: 'http://download.test' },
    ]);
    await context.route('http://download.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Downloads fixture</title><a href="/file">Download report</a>',
      }),
    );
    const body = 'Source download content\n'.repeat(50000);
    let sourceRequests = 0;
    await context.route('http://download.test/file', (route) => {
      sourceRequests++;
      assert.ok(
        route.request().headers().cookie?.includes('source-only=private'),
      );
      return route.fulfill({
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report.txt"',
        },
        body,
      });
    });
    const source = await context.newPage();
    await source.goto('http://download.test/');
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(3000);
    await viewer.route('**/*', (route) =>
      new URL(route.request().url()).origin === new URL(service.url).origin
        ? route.continue()
        : route.abort(),
    );
    let saves = 0;
    viewer.on('download', () => saves++);
    await viewer.goto(service.url);
    await clickProjected(viewer.frameLocator('#viewport iframe').locator('a'));
    await viewer
      .getByRole('button', { name: 'Downloads', exact: true })
      .click();
    const panel = viewer.getByRole('dialog', {
      name: 'Downloads',
      exact: true,
    });
    const save = panel.getByRole('button', { name: 'Save file', exact: true });
    await save.waitFor();
    assert.equal(saves, 0);
    const saved = viewer.waitForEvent('download');
    await save.click();
    const file = await saved;
    assert.equal(file.suggestedFilename(), 'report.txt');
    assert.equal(await readFile((await file.path())!, 'utf8'), body);
    await viewer.locator('#new-tab').click();
    await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
    await viewer.waitForFunction(
      () =>
        document
          .querySelector('#viewport')
          ?.parentElement?.classList.contains('switching') === false,
    );
    await viewer.reload();
    await viewer.locator('#status.live').waitFor();
    await viewer
      .getByRole('button', { name: 'Downloads', exact: true })
      .click();
    await save.waitFor();
    assert.ok((await panel.textContent())?.includes('report.txt'));
    await mkdir('.test-artifacts', { recursive: true });
    await viewer.screenshot({ path: '.test-artifacts/downloads.png' });
    const backgroundSave = viewer.waitForEvent('download');
    await save.click();
    assert.equal(
      await readFile((await (await backgroundSave).path())!, 'utf8'),
      body,
    );
    assert.equal(sourceRequests, 1);
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);

test(
  'download reads are bounded and viewing revocation cancels a blocked transfer without exposing unrelated identities',
  { timeout: 10000 },
  async (t) => {
    const { PlaywrightSourceBrowser } =
      await import('../dist/host/playwright-source.js');
    const { BrowserProjection } = await import('../dist/host/engine.js');
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto('data:text/html,<p>Source</p>');
    const owner = new PlaywrightSourceBrowser();
    t.after(() => owner.dispose());
    const source = await owner.adopt(page);
    let closed = false;
    source.reportDownload({
      state: {
        id: 'authorized-file',
        filename: 'private.txt',
        status: 'complete',
        received: 100000,
        size: 100000,
      },
      subscribe: () => () => {},
      cancel: async () => {},
      async open(signal) {
        return (async function* () {
          try {
            yield new Uint8Array(32768);
            await new Promise<void>((_, reject) => {
              const abort = () => reject(new Error('Aborted'));
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            });
          } finally {
            closed = true;
          }
        })();
      },
    });
    const engine = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    t.after(() => engine.close());
    const observer = await engine.observe(() => {});
    await assert.rejects(observer.download('unrelated-file'));
    const file = await observer.download('authorized-file');
    for (let i = 0; i < 3; i++) await observer.download('authorized-file');
    await assert.rejects(observer.download('authorized-file'));
    const iterator = file.body[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.length, 16384);
    assert.equal((await iterator.next()).value?.length, 16384);
    const pending = assert.rejects(iterator.next());
    await observer.close();
    await pending;
    assert.equal(closed, true);
    await assert.rejects(observer.download('authorized-file'));
  },
);

test(
  'source cancellation stops a native download while other browser controls remain usable',
  { timeout: 15000 },
  async (t) => {
    const { createServer } = await import('node:http');
    const server = createServer((request, response) => {
      if (request.url === '/file') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="large.bin"',
          'content-length': '10000000',
        });
        response.write(Buffer.alloc(65536));
      } else response.end('<!doctype html><a href="/file">Download</a>');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const source = await browser.newPage();
    await source.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(3000);
    await viewer.goto(service.url);
    const native = source.waitForEvent('download');
    await clickProjected(viewer.frameLocator('#viewport iframe').locator('a'));
    const file = await native;
    await viewer
      .getByRole('button', { name: 'Downloads', exact: true })
      .click();
    const panel = viewer.getByRole('dialog', {
      name: 'Downloads',
      exact: true,
    });
    await panel
      .getByRole('button', { name: 'Cancel download', exact: true })
      .click();
    await panel.getByText('Canceled', { exact: false }).waitFor();
    assert.ok(await file.failure());
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);

test(
  'session download catalogs honor grants without attaching a background renderer',
  { timeout: 10000 },
  async (t) => {
    const { PlaywrightSourceBrowser } =
      await import('../dist/host/playwright-source.js');
    const { StandaloneSourceDirectory } =
      await import('../dist/host/directory.js');
    const { BrowserSession } = await import('../dist/host/session.js');
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    const owner = new PlaywrightSourceBrowser();
    t.after(() => owner.dispose());
    const initial = await owner.adopt(page);
    const directory = new StandaloneSourceDirectory(initial);
    t.after(() => directory.dispose());
    const background = await directory.create();
    const physical = context.pages().find((p) => p !== page)!;
    (background as any).reportDownload({
      state: {
        id: 'file-private',
        filename: 'authorized.txt',
        status: 'complete',
        received: 50000,
        size: 50000,
      },
      subscribe: () => () => {},
      cancel: async () => {},
      async open(signal: AbortSignal) {
        return (async function* () {
          yield new Uint8Array(32768);
          await new Promise<void>((_, reject) => {
            const abort = () => reject(new Error('Aborted'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
        })();
      },
    });
    const session = await BrowserSession.open(directory, {
      authorize: () => true,
    });
    t.after(() => session.close());
    const messages: any[] = [];
    let allowed = false;
    const viewer = await session.observe((m) => messages.push(m), {
      canObserve: (source) => source.id !== background.id || allowed,
    });
    assert.equal(
      messages.some(
        (m) => m.type === 'downloads' && m.target === background.id,
      ),
      false,
    );
    await assert.rejects(viewer.download(background.id, 'file-private'));
    allowed = true;
    await viewer.refreshGrants();
    assert.ok(
      messages.some(
        (m) =>
          m.type === 'downloads' &&
          m.target === background.id &&
          m.items[0]?.filename === 'authorized.txt',
      ),
    );
    assert.equal(
      await physical.evaluate(() =>
        Object.getOwnPropertyNames(window).some((key) =>
          key.startsWith('__floe_'),
        ),
      ),
      false,
    );
    const file = await viewer.download(background.id, 'file-private');
    const iterator = file.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const blocked = assert.rejects(iterator.next());
    allowed = false;
    await viewer.refreshGrants();
    await blocked;
    await assert.rejects(viewer.download(background.id, 'file-private'));
    assert.equal(viewer.currentState.active, initial.id);
  },
);
