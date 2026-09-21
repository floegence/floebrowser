import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { BrowserSession } from '../dist/host/session.js';
import type { ServerMessage } from '../src/shared/protocol.js';

test('fences stale tab commands, authorizes tab creation and leaves unrelated pages alone', async () => {
  const browser = await chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const unrelated = await context.newPage();
  let allow = false;
  const session = await BrowserSession.attach(page, { authorize: () => allow });
  const messages: ServerMessage[] = [];
  const controller = await session.connect((message) => messages.push(message));
  const original = session.currentState.active;
  const ack = () => messages.findLast((message) => message.type === 'ack');
  try {
    assert.equal(session.currentState.tabs.length, 1);
    await controller.receive({
      type: 'command',
      id: 1,
      tab: original,
      epoch: '',
      action: { kind: 'tab_new' },
    });
    assert.equal(ack()?.code, 'not_allowed');
    assert.equal(context.pages().length, 2);
    allow = true;
    await controller.receive({
      type: 'command',
      id: 2,
      tab: original,
      epoch: '',
      action: { kind: 'tab_new' },
    });
    const next = session.currentState.active;
    assert.notEqual(next, original);
    assert.equal(context.pages().length, 3);
    await controller.receive({
      type: 'command',
      id: 3,
      tab: original,
      epoch: '',
      action: { kind: 'navigate', url: 'https://must-not-navigate.invalid/' },
    });
    assert.equal(ack()?.code, 'stale_view');
    assert.equal(session.activeProjection.currentState.url, 'about:blank');
    await controller.receive({
      type: 'command',
      id: 2,
      tab: next,
      epoch: '',
      action: { kind: 'tab_new' },
    });
    assert.equal(ack()?.code, 'stale_view');
    assert.equal(context.pages().length, 3);
    await controller.receive({
      type: 'command',
      id: 4,
      tab: next,
      epoch: '',
      action: { kind: 'tab_select', tab: original },
    });
    assert.equal(session.currentState.active, original);
    await controller.receive({
      type: 'command',
      id: 5,
      tab: original,
      epoch: '',
      action: { kind: 'tab_close', tab: next },
    });
    assert.equal(context.pages().length, 2);
    assert.equal(unrelated.isClosed(), false);
    const size = page.viewportSize();
    await controller.receive({
      type: 'command',
      id: 6,
      tab: next,
      epoch: '',
      action: { kind: 'viewport', width: 900, height: 600 },
    });
    assert.equal(ack()?.code, 'stale_view');
    assert.deepEqual(
      page.viewportSize(),
      size,
      'A resize from another tab cannot change the selected tab',
    );
  } finally {
    await controller.close();
    await session.close();
    assert.equal(
      page.isClosed(),
      false,
      'Detaching preserves host-owned browser lifetime',
    );
    await browser.close();
  }
});

test('tab order is authorized session state and moving a tab preserves its controller and document', async (t) => {
  const browser = await chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext();
  const source = await context.newPage();
  let allowed = true;
  const session = await BrowserSession.attach(source, {
    authorize: () => allowed,
  });
  const messages: ServerMessage[] = [];
  let controller = await session.connect((m) => messages.push(m));
  t.after(async () => {
    await browser.close();
    await session.close();
  });
  let id = 0;
  const send = (action: any, tab = session.currentState.active) =>
    controller.receive({ type: 'command', id: ++id, tab, epoch: '', action });
  await send({ kind: 'tab_new' });
  await send({ kind: 'tab_new' });
  const [a, b, c] = session.currentState.tabs.map((tab) => tab.id);
  const active = session.activeProjection;
  messages.length = 0;
  await send({ kind: 'tab_move', tab: c, before: a });
  assert.deepEqual(
    session.currentState.tabs.map((tab) => tab.id),
    [c, a, b],
  );
  assert.equal(session.currentState.active, c);
  assert.equal(session.activeProjection, active);
  assert.equal(
    messages.some((m) => m.type === 'hello'),
    false,
    'Reordering must not re-admit the controller',
  );
  assert.equal(messages.findLast((m) => m.type === 'ack')?.ok, true);
  await controller.close();
  messages.length = 0;
  controller = await session.connect((m) => messages.push(m));
  assert.deepEqual(
    messages.find((m) => m.type === 'tabs')?.state.tabs.map((tab) => tab.id),
    [c, a, b],
  );
  allowed = false;
  await send({ kind: 'tab_move', tab: c, before: null });
  assert.equal(messages.findLast((m) => m.type === 'ack')?.code, 'not_allowed');
  allowed = true;
  await send({ kind: 'tab_move', tab: c, before: 'missing' });
  assert.equal(messages.findLast((m) => m.type === 'ack')?.code, 'stale_view');
  await send({ kind: 'tab_move', tab: c, before: null }, a);
  assert.equal(messages.findLast((m) => m.type === 'ack')?.code, 'stale_view');
  assert.deepEqual(
    session.currentState.tabs.map((tab) => tab.id),
    [c, a, b],
  );
  await send({ kind: 'tab_move', tab: a, before: null });
  assert.deepEqual(
    session.currentState.tabs.map((tab) => tab.id),
    [c, b, a],
  );
  await send({ kind: 'tab_close', tab: c });
  assert.equal(
    session.currentState.active,
    b,
    'Closing follows the visible tab order',
  );
});
