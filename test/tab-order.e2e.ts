import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { fixture } from './fixture.js';

async function setup(t: test.TestContext, count = 3) {
  const site = await fixture();
  const browser = await chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext();
  const source = await context.newPage();
  await source.goto(site.url);
  let allowed = true;
  let blocked = false;
  let release: (() => void) | undefined;
  const moves: unknown[] = [];
  const service = await createProjectionServer(source, {
    authorize: async (action) => {
      if (action.kind !== 'tab_move') return true;
      moves.push(action);
      if (blocked)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return allowed;
    },
  });
  const viewer = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  viewer.setDefaultTimeout(5000);
  const messages: any[] = [];
  viewer.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') messages.push(JSON.parse(payload));
    }),
  );
  t.after(async () => {
    release?.();
    await service.close();
    await browser.close();
    await site.close();
  });
  await viewer.goto(service.url);
  await viewer.locator('#status.live').waitFor();
  const original = service.session.currentState.active;
  for (let i = 1; i < count; i++) {
    await viewer.locator('#new-tab').click();
    await viewer.waitForFunction(
      (n) => document.querySelectorAll('[role=tab]').length === n,
      i + 1,
    );
    await viewer.locator('#status.live').waitFor();
  }
  await viewer.locator(`[data-tab="${original}"]`).click();
  await viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
  return {
    viewer,
    source,
    service,
    moves,
    messages,
    original,
    ids: service.session.currentState.tabs.map((tab) => tab.id),
    block() {
      blocked = true;
    },
    deny() {
      allowed = false;
    },
    unblock() {
      blocked = false;
      release?.();
    },
  };
}

async function order(viewer: Page, ids: string[]) {
  await viewer.waitForFunction((expected) => {
    const actual = [
      ...document.querySelectorAll<HTMLElement>('[data-tab-id]'),
    ].map((e) => e.dataset.tabId);
    return JSON.stringify(actual) === JSON.stringify(expected);
  }, ids);
}

async function drag(viewer: Page, from: string, to: string) {
  const a = (await viewer.locator(`[data-tab="${from}"]`).boundingBox())!;
  const b = (await viewer.locator(`[data-tab="${to}"]`).boundingBox())!;
  await viewer.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await viewer.mouse.down();
  await viewer.mouse.move(
    b.x + b.width / 2 + (b.x > a.x ? 25 : -25),
    b.y + b.height / 2,
    { steps: 8 },
  );
  await viewer.locator('#tabs.reordering').waitFor();
}

test('dragging foreground and background tabs preserves the live document and session order survives reload', async (t) => {
  const s = await setup(t);
  const { viewer, ids, service, original } = s;
  await viewer.frameLocator('#viewport iframe').locator('#count').click();
  await s.source.waitForFunction(
    () => document.querySelector('#count-value')?.textContent === '1',
  );
  const documentBefore = await viewer
    .frameLocator('#viewport iframe')
    .locator('html')
    .elementHandle();
  s.messages.length = 0;
  s.block();
  await drag(viewer, ids[2]!, ids[0]!);
  await viewer.mouse.up();
  await order(viewer, [ids[2]!, ids[0]!, ids[1]!]);
  assert.equal(
    service.session.currentState.active,
    original,
    'Dragging a background tab must not select it',
  );
  assert.deepEqual(
    service.session.currentState.tabs.map((t) => t.id),
    ids,
    'The local preview need not wait for source authorization',
  );
  assert.equal(
    await viewer.locator('#viewport').evaluate((e) => e.inert),
    false,
  );
  s.unblock();
  await viewer.waitForFunction(() =>
    document
      .querySelector('#tab-announcement')
      ?.textContent?.includes('position 1'),
  );
  await drag(viewer, original, ids[1]!);
  await viewer.mouse.up();
  await order(viewer, [ids[2]!, ids[1]!, original]);
  await viewer.waitForFunction(() =>
    document
      .querySelector('#tab-announcement')
      ?.textContent?.includes('position 3'),
  );
  assert.equal(
    await documentBefore!.evaluate((e) => e.isConnected),
    true,
    'Reordering does not rebuild the projected document',
  );
  assert.equal(
    s.messages.some((m) => m.type === 'snapshot' || m.type === 'hello'),
    false,
  );
  assert.equal(service.session.currentState.active, original);
  await viewer.frameLocator('#viewport iframe').locator('#count').click();
  await s.source.waitForFunction(
    () => document.querySelector('#count-value')?.textContent === '2',
  );
  await viewer.reload();
  await viewer.locator('#status.live').waitFor();
  await order(viewer, [ids[2]!, ids[1]!, original]);
  await viewer.locator(`[data-tab="${ids[1]}"]`).click({ button: 'middle' });
  await order(viewer, [ids[2]!, original]);
  assert.equal(service.session.currentState.active, original);
});

test('drag cancellation, live title updates, removed tabs and denied moves restore usable source order', async (t) => {
  const s = await setup(t);
  const { viewer, ids } = s;
  await drag(viewer, ids[0]!, ids[2]!);
  await s.source.evaluate(() => {
    document.title = 'A live title update';
  });
  await viewer
    .getByRole('tab', { name: 'A live title update', exact: true })
    .waitFor();
  assert.equal(await viewer.locator('#tabs.reordering').count(), 1);
  await viewer.keyboard.press('Escape');
  await viewer.mouse.up();
  await order(viewer, ids);
  assert.equal(s.moves.length, 0);
  await drag(viewer, ids[0]!, ids[2]!);
  await viewer.mouse.move(400, 200);
  await viewer.mouse.up();
  await order(viewer, ids);
  assert.equal(s.moves.length, 0, 'Dropping outside the strip cancels');
  await drag(viewer, ids[0]!, ids[2]!);
  await viewer.locator('#tabs').dispatchEvent('pointercancel');
  await viewer.mouse.up();
  await order(viewer, ids);
  assert.equal(s.moves.length, 0);
  s.deny();
  await drag(viewer, ids[0]!, ids[2]!);
  await viewer.mouse.up();
  await viewer.locator('#toast:not([hidden])').waitFor();
  await order(viewer, ids);
  assert.equal(s.moves.length, 1);
  await drag(viewer, ids[0]!, ids[2]!);
  await s.source.close();
  await order(viewer, ids.slice(1));
  await viewer.mouse.up();
  assert.equal(await viewer.locator('#tabs.reordering').count(), 0);
  assert.equal(
    s.moves.length,
    1,
    'Closing the dragged source cancels the gesture',
  );
  await viewer.locator(`[data-tab="${ids[2]}"]`).click();
  await viewer.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-tab="${id}"]`)
        ?.getAttribute('aria-selected') === 'true',
    ids[2],
  );
});

test('overflowing tab strips auto-scroll during drag and support keyboard reordering without losing focus', async (t) => {
  const s = await setup(t, 6);
  const { viewer, ids, original } = s;
  await viewer.setViewportSize({ width: 390, height: 720 });
  await viewer.locator(`[data-tab="${original}"]`).scrollIntoViewIfNeeded();
  const first = (await viewer
    .locator(`[data-tab="${original}"]`)
    .boundingBox())!;
  const strip = (await viewer.locator('#tabs').boundingBox())!;
  await viewer.mouse.move(
    first.x + first.width / 2,
    first.y + first.height / 2,
  );
  await viewer.mouse.down();
  await viewer.mouse.move(
    strip.x + strip.width - 3,
    first.y + first.height / 2,
    { steps: 8 },
  );
  await viewer.waitForFunction(() => {
    const tabs = document.querySelector('#tabs')!;
    return tabs.scrollLeft >= tabs.scrollWidth - tabs.clientWidth - 2;
  });
  await viewer.mouse.up();
  const reordered = [...ids.slice(1), original];
  await order(viewer, reordered);
  await viewer.waitForFunction(() =>
    document
      .querySelector('#tab-announcement')
      ?.textContent?.includes('position 6'),
  );
  const tab = viewer.locator(`[data-tab="${original}"]`);
  await tab.focus();
  await tab.press('Alt+Shift+Home');
  await order(viewer, ids);
  await viewer.waitForFunction(() =>
    document
      .querySelector('#tab-announcement')
      ?.textContent?.includes('position 1'),
  );
  assert.equal(await tab.evaluate((e) => e === document.activeElement), true);
  await tab.press('Alt+Shift+ArrowRight');
  await order(viewer, [ids[1]!, ids[0]!, ...ids.slice(2)]);
  await viewer.waitForFunction(() =>
    document
      .querySelector('#tab-announcement')
      ?.textContent?.includes('position 2'),
  );
  assert.equal(s.service.session.currentState.active, original);
  assert.equal(await tab.evaluate((e) => e === document.activeElement), true);
});
