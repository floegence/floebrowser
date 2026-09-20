import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { BrowserProjection } from '../dist/host/engine.js';
import { fixture } from './fixture.js';
import type { Action } from '../src/shared/protocol.js';

for (const navigated of [false, true])
  test(
    `snapshot failure belongs only to its source document: navigated=${navigated}`,
    { timeout: 15000 },
    async (t) => {
      const site = await fixture();
      const browser = await chromium.launch({ chromiumSandbox: true });
      const source = await browser.newPage();
      await source.goto('data:text/html,<h1>Original</h1>');
      const engine = await BrowserProjection.attach(source, {
        authorize: () => true,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.after(async () => {
        release();
        await browser.close();
        await engine.close();
        await site.close();
      });
      const cdp = (engine as any).cdp;
      const send = cdp.send.bind(cdp);
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      cdp.send = async (method: string, params: any) => {
        if (
          method === 'Runtime.evaluate' &&
          params.expression.endsWith('?.snapshot()')
        ) {
          entered();
          await gate;
          throw new Error('Snapshot context was lost');
        }
        return send(method, params);
      };
      const messages: any[] = [];
      const controller = await engine.connect((message) =>
        messages.push(message),
      );
      await waiting;
      if (navigated) {
        // Browser navigation must not wait for a snapshot of the old document.
        await controller.receive({
          type: 'command',
          id: 1,
          tab: engine.id,
          epoch: '',
          action: { kind: 'navigate', url: `${site.url}/second` },
        });
        assert.equal(engine.currentState.status, 'ready');
        assert.ok(messages.some((message) => message.type === 'snapshot'));
      }
      release();
      // Flush the snapshot failure handler after the injected CDP response.
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(engine.currentState.status, navigated ? 'ready' : 'error');
      assert.equal(
        messages.some(
          (message) =>
            message.type === 'state' && message.state.status === 'error',
        ),
        !navigated,
      );
    },
  );

test(
  're-admission rejects the previous epoch before its fresh snapshot',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch({ chromiumSandbox: true });
    const source = await browser.newPage();
    await source.goto('data:text/html,<input autofocus>');
    const engine = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(async () => {
      release();
      await browser.close();
      await engine.close();
    });
    let snapshot!: (message: any) => void;
    const initial = new Promise<any>((resolve) => {
      snapshot = resolve;
    });
    const first = await engine.connect((message) => {
      if (message.type === 'snapshot') snapshot(message);
    });
    const old = await initial;
    await first.close();
    const cdp = (engine as any).cdp;
    const send = cdp.send.bind(cdp);
    cdp.send = async (method: string, params: any) => {
      if (
        method === 'Runtime.evaluate' &&
        params.expression.endsWith('?.snapshot()')
      )
        await gate;
      return send(method, params);
    };
    const messages: any[] = [];
    const second = await engine.connect((message) => messages.push(message));
    await second.receive({
      type: 'command',
      id: 1,
      tab: engine.id,
      epoch: old.epoch,
      action: { kind: 'text', text: 'must not type' },
    });
    assert.ok(
      messages.some(
        (message) =>
          message.type === 'ack' &&
          !message.ok &&
          message.code === 'stale_view',
      ),
    );
    assert.equal(await source.locator('input').inputValue(), '');
    release();
  },
);

async function setup(
  t: test.TestContext,
  authorize: (action: Action) => boolean | Promise<boolean> = () => true,
) {
  const site = await fixture();
  const browser = await chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext();
  const source = await context.newPage();
  const service = await createProjectionServer(source, {
    authorize,
  });
  const viewer = await browser.newPage();
  viewer.setDefaultTimeout(4000);
  // Exercise action expiry without spending 25 seconds on each stalled page.
  await viewer.addInitScript(() => {
    const original = window.setTimeout;
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...args: any[]
    ) =>
      original(
        handler,
        delay === 25000 ? 1800 : delay,
        ...args,
      )) as typeof setTimeout;
  });
  t.after(async () => {
    await browser.close();
    await service.close();
    await site.close();
  });
  await source.goto(site.url);
  await viewer.goto(service.url);
  await viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
  const original = service.session.currentState.active;
  await viewer.locator('#new-tab').click();
  await viewer.waitForFunction(
    () => document.querySelectorAll('[role=tab]').length === 2,
  );
  await viewer.locator('#status.live').waitFor();
  const second = service.session.currentState.active;
  assert.notEqual(original, second);
  const other = context.pages().find((page) => page !== source)!;
  await other.goto(`${site.url}/second`);
  await viewer.frameLocator('#viewport iframe').locator('#second').waitFor();
  return { site, browser, source, other, viewer, service, original, second };
}

test(
  'slow navigation cannot delay switching, healthy input, or closing the background tab',
  { timeout: 15000 },
  async (t) => {
    const s = await setup(t);
    let requested!: () => void;
    const loading = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await s.other.route(`${s.site.url}/slow`, () => {
      requested();
    });
    await s.viewer.locator('#address').fill(`${s.site.url}/slow`);
    await s.viewer.locator('#address').press('Enter');
    await loading;
    const start = performance.now();
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    const count = s.viewer.frameLocator('#viewport iframe').locator('#count');
    await count.waitFor({ timeout: 1200 });
    await count.click();
    await s.source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '1',
      null,
      { timeout: 1200 },
    );
    t.diagnostic(
      `Slow navigation to healthy source action: ${Math.round(performance.now() - start)} ms`,
    );
    await s.viewer
      .locator(`[data-tab="${s.second}"]`)
      .click({ button: 'middle' });
    await s.viewer
      .locator(`[data-tab="${s.second}"]`)
      .waitFor({ state: 'detached', timeout: 1200 });
    assert.equal(s.other.isClosed(), true);
    assert.equal(
      await s.viewer.locator('#connection-overlay').isVisible(),
      false,
    );
  },
);

test(
  'a stalled renderer and its expired action cannot disconnect or block another tab',
  { timeout: 15000 },
  async (t) => {
    const s = await setup(t);
    const cdp = await s.other.context().newCDPSession(s.other);
    // This blocks only a disposable source renderer. Browser-level teardown in
    // the fixture terminates it even when the application cannot release it.
    void cdp
      .send('Runtime.evaluate', { expression: 'for (;;) {}' })
      .catch(() => {});
    await s.viewer.frameLocator('#viewport iframe').locator('#second').hover();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(
      await s.viewer.locator('#connection-overlay').isVisible(),
      false,
      'An expired page action must not close the session',
    );
    const start = performance.now();
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    const count = s.viewer.frameLocator('#viewport iframe').locator('#count');
    await count.waitFor({ timeout: 1200 });
    assert.equal(await s.viewer.locator('#toast').isVisible(), false);
    await count.click();
    await s.source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '1',
      null,
      { timeout: 1200 },
    );
    t.diagnostic(
      `Stalled renderer to healthy source action: ${Math.round(performance.now() - start)} ms`,
    );
    await s.viewer.locator(`[data-tab="${s.second}"]`).click();
    await s.viewer.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-tab="${id}"]`)
          ?.getAttribute('aria-selected') === 'true',
      s.second,
    );
    await s.viewer.reload();
    await s.viewer.locator('#new-tab').waitFor();
    await s.viewer.locator('#new-tab').click({ timeout: 1200 });
    await s.viewer.waitForFunction(
      () => document.querySelectorAll('[role=tab]').length === 3,
      null,
      { timeout: 1200 },
    );
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    await count.waitFor({ timeout: 1200 });
    assert.equal(
      await s.viewer.locator('#connection-overlay').isVisible(),
      false,
    );
    await count.click();
    await s.source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '2',
      null,
      { timeout: 1200 },
    );
    await s.viewer
      .locator(`[data-tab="${s.second}"]`)
      .click({ button: 'middle' });
    await s.viewer
      .locator(`[data-tab="${s.second}"]`)
      .waitFor({ state: 'detached', timeout: 1200 });
  },
);

test(
  'late authorization and queued input stay revoked after changing tabs',
  { timeout: 15000 },
  async (t) => {
    let blocked = false;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t.after(() => release());
    const s = await setup(t, async (action) => {
      if (blocked && action.kind === 'pointer' && action.phase === 'down') {
        entered();
        await gate;
      }
      return true;
    });
    await s.other.goto(s.site.url);
    const count = s.viewer.frameLocator('#viewport iframe').locator('#count');
    await count.waitFor();
    blocked = true;
    await count.click();
    await waiting;
    blocked = false;
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    await count.waitFor({ timeout: 1200 });
    await count.click();
    await s.source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '1',
    );
    release();
    await s.viewer.locator(`[data-tab="${s.second}"]`).click();
    await count.waitFor({ timeout: 1200 });
    assert.equal(await s.other.locator('#count-value').textContent(), '0');
    await count.click();
    await s.other.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '1',
    );
  },
);

test(
  'background mutation traffic stops at the source and reactivation obtains fresh DOM',
  { timeout: 15000 },
  async (t) => {
    const s = await setup(t);
    const cdp = (s.service.engine as any).cdp;
    let mutations = 0;
    cdp.on('Runtime.bindingCalled', (event: { payload: string }) => {
      const data = JSON.parse(event.payload);
      if (data.type === 3 && data.data.source === 0) mutations++;
    });
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    await s.viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
    // A source round trip follows the suspension request before measuring traffic.
    await s.other.evaluate(() => (document.title = 'Background source'));
    await s.viewer
      .getByRole('tab', { name: 'Background source', exact: true })
      .waitFor();
    mutations = 0;
    await s.other.evaluate(async () => {
      const label = document.querySelector('#second')!;
      for (let i = 0; i < 30; i++) {
        label.textContent = `Background update ${i}`;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    assert.equal(
      mutations,
      0,
      'Inactive DOM must not be serialized onto the host binding',
    );
    await s.viewer.locator(`[data-tab="${s.second}"]`).click();
    const projected = s.viewer
      .frameLocator('#viewport iframe')
      .locator('#second');
    await projected.waitFor();
    assert.equal(await projected.textContent(), 'Background update 29');
  },
);

test(
  'a crashed page can be closed without interrupting the healthy tab',
  { timeout: 15000 },
  async (t) => {
    const s = await setup(t);
    const cdp = await s.other.context().newCDPSession(s.other);
    const crashed = s.other.waitForEvent('crash');
    void cdp.send('Page.crash').catch(() => {});
    await crashed;
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    const count = s.viewer.frameLocator('#viewport iframe').locator('#count');
    await count.waitFor({ timeout: 1200 });
    await count.click();
    await s.source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '1',
    );
    await s.viewer
      .locator(`[data-tab="${s.second}"]`)
      .click({ button: 'middle' });
    await s.viewer
      .locator(`[data-tab="${s.second}"]`)
      .waitFor({ state: 'detached', timeout: 1200 });
    assert.equal(
      await s.viewer.locator('#connection-overlay').isVisible(),
      false,
    );
  },
);

test(
  'slow popup attachment does not hold tab controls or override a later selection',
  { timeout: 15000 },
  async (t) => {
    const attach = BrowserProjection.attach;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    t.after(() => {
      release();
      BrowserProjection.attach = attach;
    });
    const s = await setup(t);
    BrowserProjection.attach = async (page, options) => {
      entered();
      await gate;
      return attach(page, options);
    };
    await s.other.evaluate((url) => {
      window.open(url);
    }, `${s.site.url}/second`);
    await waiting;
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    const count = s.viewer.frameLocator('#viewport iframe').locator('#count');
    await count.waitFor({ timeout: 1200 });
    release();
    await s.viewer.waitForFunction(
      () => document.querySelectorAll('[role=tab]').length === 3,
    );
    assert.equal(s.service.session.currentState.active, s.original);
    await count.click();
    await s.source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '1',
    );
  },
);

test(
  'failed input cleanup blocks that page without blocking session reconnection',
  { timeout: 15000 },
  async (t) => {
    const s = await setup(t);
    (s.service.engine as any).releaseInput = async () => {
      throw new Error('Fixture input cleanup failure');
    };
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    const count = s.viewer.frameLocator('#viewport iframe').locator('#count');
    await count.waitFor({ timeout: 1200 });
    await s.viewer.locator(`[data-tab="${s.second}"]`).click();
    await s.viewer
      .getByRole('heading', { name: 'This page couldn’t be loaded' })
      .waitFor();
    const before = s.other.url();
    await s.viewer.locator('#address').fill(s.site.url);
    await s.viewer.locator('#address').press('Enter');
    await s.viewer
      .getByText('The source page is unavailable.', { exact: true })
      .waitFor();
    assert.equal(
      s.other.url(),
      before,
      'Failed cleanup must not admit new effects to that page',
    );
    await s.viewer.reload();
    await s.viewer
      .getByRole('heading', { name: 'This page couldn’t be loaded' })
      .waitFor();
    await s.viewer.locator(`[data-tab="${s.original}"]`).click();
    await count.waitFor({ timeout: 1200 });
    await count.click();
    await s.source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '1',
    );
  },
);
