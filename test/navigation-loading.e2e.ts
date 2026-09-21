import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import type { BrowserState } from '../src/shared/protocol.js';
import { fixture } from './fixture.js';

for (const mode of ['parser', 'deferred'])
  test(
    `opening a popup before DOMContentLoaded never presents a load failure: ${mode}`,
    { timeout: 15000 },
    async (t) => {
      const site = await fixture();
      const browser = await chromium.launch({ chromiumSandbox: true });
      const context = await browser.newContext();
      const source = await context.newPage();
      const states: BrowserState[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await context.route(`${site.url}/pending.js`, async (route) => {
        await gate;
        await route.fulfill({ contentType: 'text/javascript', body: '' });
      });
      await context.route(`${site.url}/popup`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><title>Opening page</title><h1 id="destination">Destination</h1><script ${mode === 'deferred' ? 'defer' : ''} src="/pending.js"></script>`,
        }),
      );
      const service = await createProjectionServer(source, {
        authorize: () => true,
        onState: (state) => states.push(state),
      });
      const viewer = await browser.newPage();
      viewer.setDefaultTimeout(10000);
      t.after(async () => {
        release();
        await browser.close();
        await service.close();
        await site.close();
      });
      await source.goto(site.url);
      await source.evaluate((url) => {
        const link = document.createElement('a');
        link.id = 'popup';
        link.href = url;
        link.target = '_blank';
        link.textContent = 'Open page';
        document.body.prepend(link);
      }, `${site.url}/popup`);
      await viewer.goto(service.url);
      const original = service.session.currentState.active;
      await viewer.frameLocator('#viewport iframe').locator('#popup').click();
      await viewer.waitForFunction(
        () => document.querySelectorAll('[role="tab"]').length === 2,
      );
      // The parser-blocking script leaves the real new document open for admission.
      // Wait for its initial snapshot attempt to settle, without releasing the script.
      const popup = service.session.currentState.active;
      const engine = (await service.session.projection(popup)) as any;
      await engine.queue;
      for (let i = 0; i < 100 && engine.snapshotPending; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        await context
          .pages()
          .find((page) => page !== source && page !== viewer)!
          .evaluate(() => document.readyState),
        mode === 'deferred' ? 'interactive' : 'loading',
      );
      // Attaching after parsing may already yield usable DOM even though a
      // deferred script remains pending. Neither case is a load failure.
      assert.notEqual(engine.currentState.status, 'error');
      assert.equal(await viewer.locator('.floe-page-error').isVisible(), false);
      await viewer.locator(`[data-tab="${original}"]`).click();
      await viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
      await viewer.locator(`[data-tab="${popup}"]`).click();
      await viewer.reload();
      await viewer
        .locator(`[data-tab="${popup}"][aria-selected="true"]`)
        .waitFor();
      assert.equal(await viewer.locator('.floe-page-error').isVisible(), false);
      release();
      await viewer
        .frameLocator('#viewport iframe')
        .locator('#destination')
        .waitFor();
      assert.deepEqual(
        states.filter((s) => s.status === 'error'),
        [],
      );
    },
  );

test(
  'a late error-document state read cannot overwrite a successfully loaded replacement',
  { timeout: 15000 },
  async (t) => {
    const site = await fixture();
    const browser = await chromium.launch({ chromiumSandbox: true });
    const source = await browser.newPage();
    await source.route(`${site.url}/failed`, (route) =>
      route.abort('connectionfailed'),
    );
    await source.goto(`${site.url}/failed`).catch(() => {});
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(10000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(async () => {
      release();
      await browser.close();
      await service.close();
      await site.close();
    });
    await viewer.goto(service.url);
    await viewer.locator('.floe-page-error').waitFor();
    const engine = service.engine as any;
    const cdp = engine.cdp;
    const send = cdp.send.bind(cdp);
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let held = false;
    cdp.send = async (method: string, params: any) => {
      const result = await send(method, params);
      if (method === 'Page.getFrameTree' && !held) {
        held = true;
        assert.equal(
          result.frameTree.frame.unreachableUrl,
          `${site.url}/failed`,
        );
        entered();
        await gate;
      }
      return result;
    };
    const oldRead = engine.refreshState();
    await waiting;
    await source.goto(`${site.url}/second`);
    await viewer.frameLocator('#viewport iframe').locator('#second').waitFor();
    release();
    await oldRead;
    assert.equal(service.engine.currentState.status, 'ready');
    assert.equal(service.engine.currentState.url, `${site.url}/second`);
    assert.equal(await viewer.locator('.floe-page-error').isVisible(), false);
  },
);

for (const redirect of ['redirect', 'client-redirect'])
  test(
    `new-tab address navigation through ${redirect} never flashes an error`,
    { timeout: 15000 },
    async (t) => {
      const site = await fixture();
      const browser = await chromium.launch({ chromiumSandbox: true });
      const context = await browser.newContext();
      const source = await context.newPage();
      const errors: BrowserState[] = [];
      await context.route(`${site.url}/client-redirect`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><script>location.replace("/redirect")</script>',
        }),
      );
      const service = await createProjectionServer(source, {
        authorize: () => true,
        onState: (state) => {
          if (state.status === 'error') errors.push(state);
        },
      });
      const viewer = await browser.newPage();
      viewer.setDefaultTimeout(10000);
      t.after(async () => {
        await browser.close();
        await service.close();
        await site.close();
      });
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      await viewer.locator('#new-tab').click();
      await viewer.waitForFunction(
        () => document.querySelectorAll('[role="tab"]').length === 2,
      );
      await viewer.locator('#address:not([readonly])').waitFor();
      await viewer.locator('#address').fill(`${site.url}/${redirect}`);
      await viewer.locator('#address').press('Enter');
      await viewer
        .frameLocator('#viewport iframe')
        .locator('#next-click')
        .click();
      const destination = context
        .pages()
        .find((page) => page !== source && page !== viewer);
      assert.ok(destination, 'The managed source tab must remain addressable');
      await destination.waitForFunction(
        () =>
          document.querySelector('#next-click')?.textContent === 'Clicked once',
      );
      assert.equal(await viewer.locator('.floe-page-error').isVisible(), false);
      assert.equal(await viewer.locator('#toast').isVisible(), false);
      assert.equal(
        await viewer.locator('#address').inputValue(),
        `${site.url}/second`,
      );
      assert.deepEqual(errors, []);
    },
  );

test(
  'an already installed recorder waits for its first snapshot while deferred scripts are pending',
  { timeout: 15000 },
  async (t) => {
    const site = await fixture();
    const browser = await chromium.launch({ chromiumSandbox: true });
    const source = await browser.newPage();
    const errors: BrowserState[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await source.route(`${site.url}/pending.js`, async (route) => {
      await gate;
      await route.fulfill({ contentType: 'text/javascript', body: '' });
    });
    await source.route(`${site.url}/deferred`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><h1 id="destination">Deferred page</h1><script defer src="/pending.js"></script>',
      }),
    );
    const service = await createProjectionServer(source, {
      authorize: () => true,
      onState: (state) => {
        if (state.status === 'error') errors.push(state);
      },
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(10000);
    t.after(async () => {
      release();
      await browser.close();
      await service.close();
      await site.close();
    });
    await source.goto(`${site.url}/deferred`, { waitUntil: 'commit' });
    await source.waitForFunction(() => document.readyState === 'interactive');
    await viewer.goto(service.url);
    await viewer.locator('#status.refreshing').waitFor();
    const engine = service.engine as any;
    await engine.queue;
    for (let i = 0; i < 100 && engine.snapshotPending; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.engine.currentState.status, 'loading');
    assert.equal(await viewer.locator('.floe-page-error').isVisible(), false);
    release();
    await viewer
      .frameLocator('#viewport iframe')
      .locator('#destination')
      .waitFor();
    assert.deepEqual(errors, []);
  },
);
