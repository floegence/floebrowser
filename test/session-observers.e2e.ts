import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { BrowserSession } from '../dist/host/session.js';
import type { ServerMessage } from '../src/shared/protocol.js';

const wait = async (predicate: () => boolean) => {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end)
    await new Promise((done) => setTimeout(done, 10));
  assert.ok(predicate(), 'Expected source observation was not reached');
};

test(
  'session viewers select independently, cannot input without authority, and revoke private observation immediately',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Private source</title><input>');
    const session = await BrowserSession.attach(page, {
      authorize: () => true,
    });
    t.after(() => session.close());
    const a: ServerMessage[] = [],
      b: ServerMessage[] = [];
    const first = await session.connect((message) => a.push(message));
    const original = first.currentState.active;
    let visible = true;
    const second = await session.observe((message) => b.push(message), {
      canObserve: (page) => visible || page.id !== original,
    });
    await wait(() => b.some((m) => m.type === 'snapshot'));
    let id = 0;
    const send = (connection: any, action: any, epoch = '') =>
      connection.receive({
        type: 'command',
        id: ++id,
        tab: connection.currentState.active,
        epoch,
        action,
      });
    await send(second, {
      kind: 'navigate',
      url: 'https://must-not-open.invalid/',
    });
    assert.equal(b.findLast((m) => m.type === 'ack')?.code, 'not_allowed');
    const size = page.viewportSize();
    await send(second, { kind: 'viewport', width: 800, height: 600 });
    assert.deepEqual(
      page.viewportSize(),
      size,
      'Watching does not own the source viewport',
    );
    await send(second, { kind: 'tab_new' });
    assert.equal(context.pages().length, 1);
    assert.equal(
      await second.acquireControl(() => true),
      false,
      'Watching cannot steal existing user or AI control',
    );
    await send(first, { kind: 'tab_new' });
    const other = first.currentState.active;
    assert.notEqual(other, original);
    assert.equal(
      second.currentState.active,
      original,
      'Selecting in one viewer cannot change another viewer',
    );
    assert.equal(await second.acquireControl(() => true), true);
    await page.locator('input').focus();
    const epoch = b.findLast((m) => m.type === 'snapshot')!.epoch;
    await send(second, { kind: 'text', text: 'one effect' }, epoch);
    assert.equal(await page.locator('input').inputValue(), 'one effect');
    await second.releaseControl();
    await send(second, { kind: 'text', text: ' must not execute' }, epoch);
    assert.equal(await page.locator('input').inputValue(), 'one effect');
    assert.equal(b.findLast((m) => m.type === 'ack')?.code, 'not_allowed');
    visible = false;
    const revokedAt = b.length;
    const revocation = second.refreshGrants();
    assert.ok(!second.currentState.tabs.some((tab) => tab.id === original));
    await page.evaluate(() => {
      document.body.append('private change');
    });
    await revocation;
    await wait(() => second.currentState.active === other);
    assert.equal(
      b
        .slice(revokedAt)
        .some((m) => m.type === 'state' && m.state.id === original),
      false,
    );
    assert.ok(
      b
        .slice(revokedAt)
        .some(
          (message) =>
            message.type === 'media_end' && message.target === original,
        ),
      'Revocation retires the client decoder even after removing the source grant',
    );
    assert.equal(await second.readResource(original, 'unknown'), undefined);
    assert.equal(second.currentState.tabs.length, 1);
    await second.close();
    assert.equal(first.currentState.active, other);
    await first.close();
    assert.equal(page.isClosed(), false);
  },
);

test(
  'pending input and resource replies cannot cross a changed observation grant',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto('data:text/html,<input>');
    const session = await BrowserSession.attach(page, {
      authorize: () => true,
    });
    t.after(() => session.close());
    let allowed = true;
    const messages: ServerMessage[] = [];
    const connection = await session.observe(
      (message) => messages.push(message),
      { canObserve: () => allowed },
    );
    await wait(() => messages.some((message) => message.type === 'snapshot'));
    let admit!: () => void;
    let authorizing = false;
    await connection.acquireControl((action) =>
      action.kind === 'text'
        ? new Promise((resolve) => {
            authorizing = true;
            admit = () => resolve(true);
          })
        : true,
    );
    const target = connection.currentState.active;
    await page.locator('input').focus();
    const input = connection.receive({
      type: 'command',
      tab: target,
      id: 1,
      epoch: messages.findLast((m) => m.type === 'snapshot')!.epoch,
      action: { kind: 'text', text: 'must stay private' },
    });
    await wait(() => authorizing);
    const projection = await session.projection(target);
    let releaseResource!: () => void;
    const original = projection.resources.read;
    projection.resources.read = () =>
      new Promise((resolve) => {
        releaseResource = () =>
          resolve({ body: Buffer.from('private bytes'), type: 'text/plain' });
      });
    t.after(() => {
      projection.resources.read = original;
    });
    const resource = connection.readResource(target, 'held-resource');
    allowed = false;
    // The execution guard rechecks permission after the pending policy decision.
    admit();
    await input;
    assert.equal(await page.locator('input').inputValue(), '');
    assert.equal(
      messages.findLast((m) => m.type === 'ack')?.code,
      'not_allowed',
    );
    const revocation = connection.refreshGrants();
    releaseResource();
    assert.equal(
      await resource,
      undefined,
      'An in-flight resource read is rejected after revocation',
    );
    await revocation;
    await connection.close();
  },
);
