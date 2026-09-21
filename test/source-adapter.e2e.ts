import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { CDPSourcePage } from '../src/host/cdp-source.js';
import { BrowserProjection } from '../dist/host/engine.js';
import type { ServerMessage } from '../src/shared/protocol.js';

const eventually = async (condition: () => boolean) => {
  const end = Date.now() + 5000;
  while (!condition() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(condition(), 'Expected source projection was not reached');
};

test(
  'a host-owned source identity and debugger remain authoritative across projection lifetimes',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(
      '<h1>Shared source</h1><input id="entry"><iframe srcdoc="<h2>Same process child</h2>"></iframe>',
    );
    const transport = await page.context().newCDPSession(page);
    const calls: string[] = [];
    const send = transport.send.bind(transport);
    transport.send = ((method: any, parameters: any) => {
      calls.push(method);
      return send(method, parameters);
    }) as typeof transport.send;
    let hostEvents = 0;
    transport.on('Runtime.consoleAPICalled', () => hostEvents++);
    const source = await CDPSourcePage.attach({
      id: 'host-owned-target',
      transport,
    });
    t.after(() => source.dispose());
    const messages: ServerMessage[] = [];
    const projection = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    t.after(() => projection.close());
    assert.equal(projection.id, 'host-owned-target');
    const control = await projection.connect((message) =>
      messages.push(message),
    );
    await eventually(() =>
      messages.some((message) => message.type === 'snapshot'),
    );
    const snapshot = messages.findLast(
      (message) => message.type === 'snapshot',
    )!;
    await page.locator('#entry').focus();
    await control.receive({
      type: 'command',
      id: 1,
      tab: projection.id,
      epoch: snapshot.epoch,
      action: { kind: 'text', text: 'shared input' },
    });
    assert.equal(await page.locator('#entry').inputValue(), 'shared input');
    await projection.close();
    const eventsBefore = hostEvents;
    await send('Runtime.evaluate', {
      expression: 'console.log("host listener retained")',
    });
    assert.equal(hostEvents, eventsBefore + 1);
    assert.equal(page.isClosed(), false);
    assert.ok(
      !calls.some((method) =>
        /^(Target\.(attach|detach|setAutoAttach)|Runtime.disable|Network.disable)/.test(
          method,
        ),
      ),
    );
    const next = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    t.after(() => next.close());
    assert.equal(
      next.id,
      projection.id,
      'Projection recreation cannot change source identity',
    );
    const later: ServerMessage[] = [];
    await next.connect((message) => later.push(message));
    await eventually(() =>
      later.some((message) => message.type === 'snapshot'),
    );
  },
);

test('an already enabled host debugger supplies its existing frame contexts without resetting domains', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<h1>Preexisting source</h1><iframe srcdoc="child"></iframe>',
  );
  const transport = await page.context().newCDPSession(page);
  const contexts: Array<{
    id: number;
    auxData?: { isDefault?: boolean; frameId?: string };
  }> = [];
  transport.on('Runtime.executionContextCreated', ({ context }) =>
    contexts.push(context),
  );
  await transport.send('Runtime.enable');
  assert.ok(contexts.length >= 2);
  const source = await CDPSourcePage.attach({
    id: 'preexisting-source',
    transport,
    contexts,
  });
  t.after(() => source.dispose());
  assert.equal(await source.title(), '');
  assert.ok(source.frames().every((frame) => frame.contextID > 0));
  const projection = await BrowserProjection.attach(source, {
    authorize: () => true,
  });
  t.after(() => projection.close());
  const messages: ServerMessage[] = [];
  await projection.connect((message) => messages.push(message));
  await eventually(() =>
    messages.some((message) => message.type === 'snapshot'),
  );
  const navigation = await transport.send('Page.getNavigationHistory');
  await projection.close();
  assert.deepEqual(
    await transport.send('Page.getNavigationHistory'),
    navigation,
  );
});
