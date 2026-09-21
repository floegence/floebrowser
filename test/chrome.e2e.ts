import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { fixture } from './fixture.js';

async function setup(t: test.TestContext) {
  const site = await fixture();
  const browser = await chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext();
  const source = await context.newPage();
  await source.goto(site.url);
  let release: (() => void) | undefined;
  let blocked = false;
  let allowed = true;
  const selections: string[] = [];
  const service = await createProjectionServer(source, {
    authorize: async (action) => {
      if (action.kind === 'tab_select') {
        selections.push(action.tab);
        if (blocked)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      }
      return action.kind !== 'tab_select' || allowed;
    },
  });
  const viewer = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  viewer.setDefaultTimeout(5000);
  const failures: unknown[] = [];
  const timings: number[] = [];
  let started = 0;
  viewer.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(String(payload));
      if (m.action?.kind === 'tab_select') started = performance.now();
    });
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(String(payload));
      if (m.type === 'ack' && !m.ok) failures.push(m);
      if (m.type === 'snapshot' && started) {
        timings.push(performance.now() - started);
        started = 0;
      }
    });
  });
  t.after(async () => {
    blocked = false;
    release?.();
    await service.close();
    await browser.close();
    await site.close();
  });
  await viewer.goto(service.url);
  await viewer.locator('#status.live').waitFor();
  return {
    site,
    source,
    viewer,
    service,
    selections,
    failures,
    timings,
    deny() {
      allowed = false;
    },
    block() {
      blocked = true;
    },
    unblock() {
      blocked = false;
      release?.();
    },
  };
}

test('tab clicks respond immediately, coalesce unsent selections and preserve source input fences', async (t) => {
  const s = await setup(t);
  const { viewer, source, service } = s;
  const original = service.session.currentState.active;
  for (let i = 0; i < 2; i++) {
    await viewer.locator('#new-tab').click();
    await viewer.waitForFunction(
      (n) => document.querySelectorAll('[role=tab]').length === n,
      i + 2,
    );
    await viewer.locator('#status.live').waitFor();
  }
  const ids = service.session.currentState.tabs.map((tab) => tab.id);
  // Measure the unblocked path before adding a deterministic slow-source gate.
  await viewer.locator(`[data-tab="${original}"]`).click();
  await viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
  t.diagnostic(
    `Tab command to snapshot: ${s.timings.map((n) => Math.round(n)).join(', ')} ms`,
  );
  s.selections.length = 0;
  s.block();
  const selectedImmediately = await viewer
    .locator(`[data-tab="${ids[1]}"]`)
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      return button.getAttribute('aria-selected');
    });
  assert.equal(
    selectedImmediately,
    'true',
    'The clicked tab highlights in the same event turn',
  );
  assert.equal(await viewer.locator('#connection-overlay').isVisible(), false);
  assert.equal(
    await viewer.locator('#viewport').evaluate((e) => e.inert),
    true,
    'Old projected content cannot receive new input',
  );
  await viewer.locator(`[data-tab="${ids[2]}"]`).click();
  await viewer.locator(`[data-tab="${original}"]`).click();
  s.unblock();
  await viewer.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-tab="${id}"]`)
        ?.getAttribute('aria-selected') === 'true' &&
      !document.querySelector<HTMLElement>('#viewport')!.inert,
    original,
  );
  await viewer.frameLocator('#viewport iframe').locator('#count').click();
  await source.waitForFunction(
    () => document.querySelector('#count-value')?.textContent === '1',
  );
  assert.deepEqual(
    s.selections,
    [ids[1], original],
    'Only the latest unsent selection reaches the source',
  );
  assert.equal(service.session.currentState.active, original);
  assert.deepEqual(s.failures, []);
});

test('browser chrome fills the window, closes tabs with the middle button and keeps keyed tab focus', async (t) => {
  const { viewer, source, service } = await setup(t);
  const original = service.session.currentState.active;
  assert.equal(await viewer.locator('#viewport-mode').count(), 0);
  const rect = await viewer.locator('#viewport').boundingBox();
  assert.equal(rect!.x, 0);
  assert.equal(rect!.width, 1280);
  assert.equal(rect!.y + rect!.height, 900);
  assert.ok(
    rect!.y <= 90,
    'Only compact tabs and navigation sit above the page',
  );
  await viewer.locator(`[data-tab="${original}"]`).focus();
  await viewer
    .locator(`[data-tab="${original}"]`)
    .evaluate((e) => ((e as any).identity = 'retained'));
  await source.evaluate(() => (document.title = 'Updated title'));
  await viewer
    .getByRole('tab', { name: 'Updated title', exact: true })
    .waitFor();
  assert.equal(
    await viewer
      .locator(`[data-tab="${original}"]`)
      .evaluate((e) => (e as any).identity),
    'retained',
  );
  assert.equal(
    await viewer
      .locator(`[data-tab="${original}"]`)
      .evaluate((e) => document.activeElement === e),
    true,
  );
  await viewer.locator('#new-tab').click();
  await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
  await viewer.locator('#status.live').waitFor();
  const active = service.session.currentState.active;
  await viewer.locator(`[data-tab="${original}"]`).click({ button: 'middle' });
  await viewer.waitForFunction(
    () => document.querySelectorAll('[role=tab]').length === 1,
  );
  assert.equal(
    service.session.currentState.active,
    active,
    'Closing a background tab does not select it',
  );
  assert.equal(source.isClosed(), true);
  await viewer
    .getByRole('tab', { name: 'New tab', exact: true })
    .click({ button: 'middle' });
  await viewer.waitForFunction((id) => {
    const tab = document.querySelector('[role=tab]');
    return tab && tab.getAttribute('data-tab') !== id;
  }, active);
  assert.equal(
    service.session.currentState.tabs.length,
    1,
    'Closing the last tab creates one blank tab',
  );
  assert.equal(
    await viewer
      .locator('#address')
      .evaluate((e) => document.activeElement === e),
    true,
  );
});

test('address first focus selects all, subsequent clicks edit, and suggestions navigate only at the source', async (t) => {
  const { viewer, source, site } = await setup(t);
  const address = viewer.locator('#address');
  await address.click();
  assert.deepEqual(
    await address.evaluate((e: HTMLInputElement) => [
      e.selectionStart,
      e.selectionEnd,
    ]),
    [0, site.url.length + 1],
  );
  await address.click({ position: { x: 70, y: 15 } });
  const selection = await address.evaluate((e: HTMLInputElement) => [
    e.selectionStart,
    e.selectionEnd,
  ]);
  assert.equal(
    selection[0],
    selection[1],
    'A second click positions the caret',
  );
  await address.fill(`${site.url}/second`);
  await address.press('Enter');
  await viewer.frameLocator('#viewport iframe').locator('#second').waitFor();
  await address.click();
  await address.fill('Juniper');
  await viewer
    .getByRole('option')
    .filter({ hasText: 'Workspace · Juniper' })
    .waitFor();
  await address.press('ArrowDown');
  await address.press('Enter');
  await viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
  assert.equal(source.url(), `${site.url}/`);
  await address.click();
  await address.fill('unfinished edit');
  await address.press('Escape');
  assert.equal(await address.inputValue(), source.url());
  assert.equal(await viewer.getByRole('listbox').isVisible(), false);
});

test('navigation submitted while switching targets the requested tab and denied switches discard dependent intent', async (t) => {
  const s = await setup(t);
  const { viewer, source, site, service } = s;
  const original = service.session.currentState.active;
  await viewer.locator('#new-tab').click();
  await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
  await viewer.locator('#status.live').waitFor();
  const blank = service.session.currentState.active;
  s.block();
  await viewer.locator(`[data-tab="${original}"]`).click();
  await viewer.locator('#address').fill(`${site.url}/second`);
  await viewer.locator('#address').press('Enter');
  await viewer.locator(`[data-tab="${blank}"]`).click();
  s.unblock();
  await viewer.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-tab="${id}"]`)
        ?.getAttribute('aria-selected') === 'true' &&
      !document.querySelector<HTMLElement>('#viewport')!.inert,
    blank,
  );
  assert.equal(
    source.url(),
    `${site.url}/second`,
    'Navigation executes on the selected destination before the next switch',
  );
  assert.equal(
    service.session.activeProjection.currentState.url,
    'about:blank',
  );
  s.block();
  s.deny();
  await viewer.locator(`[data-tab="${original}"]`).click();
  await viewer.locator('#address').fill(`${site.url}/must-not-navigate`);
  await viewer.locator('#address').press('Enter');
  s.unblock();
  await viewer.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-tab="${id}"]`)
        ?.getAttribute('aria-selected') === 'true' &&
      !document.querySelector<HTMLElement>('#viewport')!.inert,
    blank,
  );
  assert.equal(
    service.session.activeProjection.currentState.url,
    'about:blank',
  );
  assert.equal(source.url(), `${site.url}/second`);
  assert.match(await viewer.locator('#toast').innerText(), /not authorize/);
});

test('typing during a slow tab switch stays editable and composing Enter never submits', async (t) => {
  const s = await setup(t);
  const { viewer, service } = s;
  const original = service.session.currentState.active;
  await viewer.locator('#new-tab').click();
  await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
  await viewer.locator('#status.live').waitFor();
  s.block();
  await viewer.locator(`[data-tab="${original}"]`).click();
  await viewer.locator('#address').fill('unfinished draft');
  s.unblock();
  await viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
  assert.equal(
    await viewer.locator('#address').inputValue(),
    'unfinished draft',
  );
  const before = service.session.activeProjection.currentState.url;
  await viewer.locator('#address').dispatchEvent('compositionstart');
  await viewer.locator('#address').fill('输入法');
  await viewer.locator('#address').press('Enter');
  assert.equal(service.session.activeProjection.currentState.url, before);
  assert.equal(await viewer.locator('#address-suggestions').isVisible(), false);
  await viewer.locator('#address').dispatchEvent('compositionend');
  await viewer.locator('#address').press('Escape');
  assert.equal(await viewer.locator('#address').inputValue(), before);
});

test('tab menus pin pages and source-frame shortcuts close and restore a fresh target', async (t) => {
  const { viewer, service, source, site } = await setup(t);
  const original = service.session.currentState.active;
  viewer.on('pageerror', (error) => t.diagnostic(error.message));
  await viewer
    .getByRole('tab', { name: 'Workspace · Juniper', exact: true })
    .click({ button: 'right' });
  await viewer.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
  await viewer.waitForFunction(() => !!document.querySelector('.tab.pinned'));
  assert.equal(service.session.currentState.tabs[0]!.pinned, true);
  const width = await viewer.locator('.tab.pinned').boundingBox();
  assert.ok(width!.width < 60);
  await viewer.frameLocator('#viewport iframe').locator('#count').focus();
  await viewer.keyboard.press('Control+w');
  await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
  await viewer.locator('#status.live').waitFor();
  assert.equal(source.isClosed(), true);
  await viewer.locator('#address').focus();
  await viewer.keyboard.press('Control+Shift+t');
  await viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
  assert.notEqual(service.session.currentState.active, original);
  assert.equal(
    service.session.activeProjection.currentState.url,
    `${site.url}/`,
  );
  assert.equal(
    service.session.currentState.tabs.find(
      (tab) => tab.id === service.session.currentState.active,
    )?.pinned,
    true,
  );
  assert.equal(
    await viewer
      .frameLocator('#viewport iframe')
      .locator('#count-value')
      .textContent(),
    '0',
    'Restoration does not replay old input',
  );
  await viewer.frameLocator('#viewport iframe').locator('#count').focus();
  await viewer.keyboard.press('Control+t');
  await viewer.waitForFunction(
    () => document.querySelectorAll('[role=tab]').length === 3,
  );
  await viewer.locator('#status.live').waitFor();
  assert.equal(
    await viewer
      .locator('#address')
      .evaluate((e) => e === document.activeElement),
    true,
  );
});
