import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { BrowserProjection } from '../dist/host/engine.js';
import { createProjectionServer } from '../dist/host/server.js';
import type { Action, ServerMessage } from '../src/shared/protocol.js';
import { fixture } from './fixture.js';

async function setup(
  t: test.TestContext,
  authorize: (action: Action) => boolean | Promise<boolean> = () => true,
) {
  const site = await fixture();
  const browser = await chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const service = await createProjectionServer(page, { authorize });
  await page.goto(site.url, { waitUntil: 'networkidle' });
  t.after(async () => {
    await service.close();
    await browser.close();
    await site.close();
  });
  return { site, page, service };
}
const nodeID = (node: any, htmlID: string): number | undefined =>
  node.attributes?.id === htmlID
    ? node.id
    : node.childNodes?.map((child: any) => nodeID(child, htmlID)).find(Boolean);
const snapshot = (messages: ServerMessage[]) =>
  messages.findLast(
    (message): message is Extract<ServerMessage, { type: 'snapshot' }> =>
      message.type === 'snapshot',
  )!;

async function eventually(
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Expected state was not reached');
}

test('fences duplicate IDs, stale documents, and a revoked controller', async (t) => {
  const { service, page, site } = await setup(t);
  await assert.rejects(
    BrowserProjection.attach(page, { authorize: () => true }),
    /already has a FloeBrowser projection/,
  );
  const messages: ServerMessage[] = [];
  const controller = await service.engine.connect((message) =>
    messages.push(message),
  );
  await eventually(() => !!snapshot(messages));
  const initial = snapshot(messages);
  const id = nodeID((initial.events[1] as any).data.node, 'count')!;
  const pointer = (phase: 'down' | 'up'): Action => ({
    kind: 'pointer',
    phase,
    point: { node: id, x: 0.5, y: 0.5 },
    button: 'left',
    buttons: phase === 'down' ? 1 : 0,
    modifiers: 0,
    clicks: 1,
  });
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 1,
    epoch: initial.epoch,
    action: pointer('down'),
  });
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 2,
    epoch: initial.epoch,
    action: pointer('up'),
  });
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 1,
    epoch: initial.epoch,
    action: pointer('down'),
  });
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 2,
    epoch: initial.epoch,
    action: pointer('up'),
  });
  assert.equal(await page.locator('#count-value').textContent(), '1');
  assert.ok(
    messages.some(
      (message) => message.type === 'ack' && message.id === 1 && !message.ok,
    ),
  );
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 3,
    epoch: initial.epoch,
    action: { kind: 'navigate', url: `${site.url}/second` },
  });
  await eventually(() => snapshot(messages).epoch !== initial.epoch);
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 4,
    epoch: initial.epoch,
    action: pointer('down'),
  });
  assert.ok(
    messages.some(
      (message) =>
        message.type === 'ack' &&
        message.id === 4 &&
        message.code === 'stale_view',
    ),
  );
  await controller.close();
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 5,
    epoch: initial.epoch,
    action: { kind: 'navigate', url: site.url },
  });
  assert.equal(page.url(), `${site.url}/second`);
  const reconnect: ServerMessage[] = [];
  const next = await service.engine.connect((message) =>
    reconnect.push(message),
  );
  await eventually(() => !!snapshot(reconnect));
  assert.notEqual(snapshot(reconnect).epoch, initial.epoch);
  await next.close();
});

test('checks host authorization before dispatch and prevents simultaneous controllers', async (t) => {
  const { service, page } = await setup(t, () => false);
  const messages: ServerMessage[] = [];
  const controller = await service.engine.connect((message) =>
    messages.push(message),
  );
  await eventually(() => !!snapshot(messages));
  await assert.rejects(
    service.engine.connect(() => {}),
    /already has a controller/,
  );
  const initial = snapshot(messages);
  await page.locator('#name').focus();
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 1,
    epoch: initial.epoch,
    action: { kind: 'text', text: 'unauthorized' },
  });
  assert.equal(await page.locator('#name').inputValue(), '');
  assert.ok(
    messages.some(
      (message) => message.type === 'ack' && message.code === 'not_allowed',
    ),
  );
  await controller.close();
  await service.close();
  assert.equal(
    page.isClosed(),
    false,
    'Detaching must preserve the host-owned page',
  );
  await page.locator('#count').click();
  assert.equal(await page.locator('#count-value').textContent(), '1');
});

test('revocation while authorization is pending prevents input dispatch', async (t) => {
  let allow: (allowed: boolean) => void;
  let reached: () => void;
  const authorized = new Promise<boolean>((resolve) => {
    allow = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const { service, page } = await setup(t, () => {
    reached();
    return authorized;
  });
  const messages: ServerMessage[] = [];
  const controller = await service.engine.connect((message) =>
    messages.push(message),
  );
  await eventually(() => !!snapshot(messages));
  await page.locator('#name').focus();
  const pending = controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 1,
    epoch: snapshot(messages).epoch,
    action: { kind: 'text', text: 'must not arrive' },
  });
  await entered;
  const closed = controller.close();
  allow!(true);
  await Promise.all([closed, pending]);
  assert.equal(await page.locator('#name').inputValue(), '');
});

test('loopback carrier rejects unknown capabilities, foreign origins, and raw CDP requests', async (t) => {
  const { service } = await setup(t);
  const origin = new URL(service.url).origin;
  assert.equal((await fetch(`${origin}/`)).status, 404);
  assert.equal((await fetch(`${origin}/json/version`)).status, 404);
  assert.equal((await fetch(`${service.url}assets/unknown`)).status, 404);
  const response = await fetch(service.url);
  assert.match(
    response.headers.get('content-security-policy')!,
    /form-action 'none'/,
  );
  assert.match(
    response.headers.get('content-security-policy')!,
    /connect-src 'self'/,
  );
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const endpoint = new URL('stream', service.url);
  endpoint.protocol = 'ws:';
  const rejected = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(endpoint, {
      origin: 'https://untrusted.test',
    });
    socket.on('open', () => {
      socket.close();
      resolve(false);
    });
    socket.on('unexpected-response', (_request, incoming) => {
      incoming.destroy();
      socket.terminate();
      resolve(incoming.statusCode === 403);
    });
    socket.on('error', () => {});
  });
  assert.equal(rejected, true);
});

test(
  'viewer handoff revokes pending input and preserves origin checks',
  { timeout: 15000 },
  async (t) => {
    let allow!: (value: boolean) => void;
    let entered!: () => void;
    const authorization = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    t.after(() => allow(true));
    let textCommands = 0;
    const { service, page } = await setup(t, async (action) => {
      if (action.kind === 'text' && ++textCommands === 1) {
        entered();
        return authorization;
      }
      return true;
    });
    const endpoint = new URL('stream', service.url);
    endpoint.protocol = 'ws:';
    const origin = new URL(service.url).origin;
    const first = new WebSocket(endpoint, { origin });
    const firstMessages: ServerMessage[] = [];
    first.on('message', (data) =>
      firstMessages.push(JSON.parse(data.toString())),
    );
    t.after(() => first.terminate());
    await eventually(() => !!snapshot(firstMessages));

    endpoint.search = '?takeover=1';
    const rejected = await new Promise<boolean>((resolve) => {
      const foreign = new WebSocket(endpoint, {
        origin: 'https://untrusted.test',
      });
      foreign.on('open', () => {
        foreign.close();
        resolve(false);
      });
      foreign.on('unexpected-response', (_request, response) => {
        response.destroy();
        foreign.terminate();
        resolve(response.statusCode === 403);
      });
      foreign.on('error', () => {});
    });
    assert.equal(rejected, true);
    assert.equal(first.readyState, WebSocket.OPEN);

    await page.locator('#name').focus();
    first.send(
      JSON.stringify({
        type: 'command',
        tab: service.engine.id,
        id: 1,
        epoch: snapshot(firstMessages).epoch,
        action: { kind: 'text', text: 'revoked' },
      }),
    );
    await waiting;
    first.send(
      JSON.stringify({
        type: 'command',
        tab: service.engine.id,
        id: 2,
        epoch: snapshot(firstMessages).epoch,
        action: { kind: 'text', text: 'queued' },
      }),
    );
    const firstClosed = new Promise<number>((resolve) =>
      first.on('close', resolve),
    );
    const second = new WebSocket(endpoint, { origin });
    const secondMessages: ServerMessage[] = [];
    second.on('message', (data) =>
      secondMessages.push(JSON.parse(data.toString())),
    );
    t.after(() => second.terminate());
    assert.equal(await firstClosed, 4002);
    assert.equal(
      secondMessages.length,
      0,
      'New control waits for the old input to drain',
    );
    allow(true);
    await eventually(() => !!snapshot(secondMessages));
    assert.equal(await page.locator('#name').inputValue(), '');
    assert.equal(
      textCommands,
      1,
      'Queued old input never reaches authorization',
    );
    assert.notEqual(
      snapshot(firstMessages).epoch,
      snapshot(secondMessages).epoch,
    );
    second.send(
      JSON.stringify({
        type: 'command',
        tab: service.engine.id,
        id: 1,
        epoch: snapshot(secondMessages).epoch,
        action: { kind: 'text', text: 'new viewer' },
      }),
    );
    await eventually(
      async () => (await page.locator('#name').inputValue()) === 'new viewer',
    );
  },
);

test('disconnect balances held input without completing a pending button click', async (t) => {
  const { service, page } = await setup(t);
  const messages: ServerMessage[] = [];
  const controller = await service.engine.connect((message) =>
    messages.push(message),
  );
  await eventually(() => !!snapshot(messages));
  await page.evaluate(() => {
    (window as any).releasedKeys = [];
    document.addEventListener('keyup', (event) =>
      (window as any).releasedKeys.push(event.key),
    );
  });
  const initial = snapshot(messages);
  const id = nodeID((initial.events[1] as any).data.node, 'count')!;
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 1,
    epoch: initial.epoch,
    action: {
      kind: 'key',
      phase: 'down',
      key: 'Control',
      code: 'ControlLeft',
      modifiers: 2,
    },
  });
  await controller.receive({
    type: 'command',
    tab: service.engine.id,
    id: 2,
    epoch: initial.epoch,
    action: {
      kind: 'pointer',
      phase: 'down',
      point: { node: id, x: 0.5, y: 0.5 },
      button: 'left',
      buttons: 1,
      modifiers: 0,
      clicks: 1,
    },
  });
  await controller.close();
  assert.equal(await page.locator('#count-value').textContent(), '0');
  assert.deepEqual(await page.evaluate(() => (window as any).releasedKeys), [
    'Control',
  ]);
});
