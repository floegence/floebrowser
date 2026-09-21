import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { fixture } from './fixture.js';
import { BrowserProjection } from '../dist/host/engine.js';
import type { ServerMessage } from '../src/shared/protocol.js';
import { mkdir } from 'node:fs/promises';

test(
  'source dialogs preserve user decisions and do not block their own response',
  { timeout: 20000 },
  async (t) => {
    const site = await fixture();
    t.after(() => site.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const source = await context.newPage();
    await source.route(`${site.url}/dialogs`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>Dialog source</title>
      <button id="confirm" onclick="document.querySelector('output').textContent=String(confirm('Confirm this change?'))">Confirm</button>
      <button id="prompt" onclick="document.querySelector('output').textContent=String(prompt('Enter a value', 'initial'))">Prompt</button>
      <button id="alert" onclick="alert('Message <script>literal</script>');document.querySelector('output').textContent='dismissed'">Alert</button>
      <button id="guard" onclick="window.onbeforeunload=()=>true">Protect changes</button><output></output>`,
      }),
    );
    await source.goto(`${site.url}/dialogs`);
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(3000);
    await viewer.goto(service.url);
    const content = viewer.frameLocator('#viewport iframe');
    const dialog = viewer.getByRole('dialog', {
      name: 'Website dialog',
      exact: true,
    });
    await clickProjected(content.locator('#confirm'));
    await dialog.waitFor();
    assert.ok((await dialog.textContent())?.includes(new URL(site.url).host));
    assert.ok((await dialog.textContent())?.includes('Confirm this change?'));
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await source.waitForFunction(
      () => document.querySelector('output')?.textContent === 'false',
    );
    await clickProjected(content.locator('#confirm'));
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    await source.waitForFunction(
      () => document.querySelector('output')?.textContent === 'true',
    );
    await clickProjected(content.locator('#prompt'));
    const input = dialog.getByRole('textbox', {
      name: 'Response',
      exact: true,
    });
    assert.equal(await input.inputValue(), 'initial');
    await input.fill('ユーザーの入力 🪷');
    await mkdir('.test-artifacts', { recursive: true });
    await viewer.screenshot({ path: '.test-artifacts/website-dialog.png' });
    await input.press('Enter');
    await source.waitForFunction(
      () =>
        document.querySelector('output')?.textContent === 'ユーザーの入力 🪷',
    );
    await clickProjected(content.locator('#alert'));
    await dialog.waitFor();
    assert.ok(
      (await dialog.textContent())?.includes(
        'Message <script>literal</script>',
      ),
    );
    assert.equal(await dialog.locator('script').count(), 0);
    await dialog.press('Escape');
    await source.waitForFunction(
      () => document.querySelector('output')?.textContent === 'dismissed',
    );
    assert.equal(await viewer.locator('#toast').isVisible(), false);
    await clickProjected(content.locator('#confirm'));
    await dialog.waitFor();
    await viewer.locator('#new-tab').click();
    await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
    await source.waitForFunction(
      () => document.querySelector('output')?.textContent === 'false',
    );
    assert.equal(
      await dialog.isVisible(),
      false,
      'A dialog cannot follow the user to another tab',
    );
  },
);

test(
  'waiting for a website decision does not expire its blocked source action',
  { timeout: 35000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const source = await context.newPage();
    await source.route('http://127.0.0.1/dialog-wait', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<button onclick="this.textContent=String(confirm(\'Take your time\'))">Confirm</button>',
      }),
    );
    await source.goto('http://127.0.0.1/dialog-wait');
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(3000);
    await viewer.goto(service.url);
    await clickProjected(
      viewer
        .frameLocator('#viewport iframe')
        .getByRole('button', { name: 'Confirm', exact: true }),
    );
    const dialog = viewer.getByRole('dialog', {
      name: 'Website dialog',
      exact: true,
    });
    await dialog.waitFor();
    await new Promise((resolve) => setTimeout(resolve, 26000));
    assert.equal(await viewer.locator('#toast').isVisible(), false);
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    await source.getByRole('button', { name: 'true', exact: true }).waitFor();
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);

test(
  'beforeunload cancellation preserves navigation and tab membership; confirmation closes only that tab',
  { timeout: 20000 },
  async (t) => {
    const site = await fixture();
    t.after(() => site.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const source = await context.newPage();
    const url = `${site.url}/guard`;
    await source.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Unsaved changes</title><button id="count" onclick="this.lastElementChild.textContent=Number(this.lastElementChild.textContent)+1">Change <span id="count-value">0</span></button>',
      }),
    );
    await source.goto(url);
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(3000);
    await viewer.goto(service.url);
    await clickProjected(
      viewer.frameLocator('#viewport iframe').locator('#count'),
    );
    await source.evaluate(() => {
      window.onbeforeunload = () => true;
    });
    await viewer.locator('#address').fill(`${site.url}/second`);
    await viewer.locator('#address').press('Enter');
    const dialog = viewer.getByRole('dialog', {
      name: 'Website dialog',
      exact: true,
    });
    await dialog
      .getByRole('button', { name: 'Stay on page', exact: true })
      .click();
    await viewer.locator('#status.live').waitFor();
    assert.equal(source.url(), url);
    assert.equal(await viewer.locator('#toast').isVisible(), false);
    await clickProjected(
      viewer.frameLocator('#viewport iframe').locator('#count'),
    );
    await source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '2',
    );
    const id = service.session.currentState.active;
    await viewer.locator(`[data-tab-id="${id}"] .tab-close`).click();
    await dialog
      .getByRole('button', { name: 'Stay on page', exact: true })
      .click();
    assert.equal(source.isClosed(), false);
    await viewer.locator('#status.live').waitFor();
    await viewer.locator(`[data-tab-id="${id}"] .tab-close`).click();
    await dialog
      .getByRole('button', { name: 'Leave page', exact: true })
      .click();
    await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
    assert.equal(source.isClosed(), true);
    assert.equal(service.session.currentState.tabs.length, 1);
    assert.notEqual(service.session.currentState.active, id);
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);

test(
  'dialog identities belong only to their controller and revocation dismisses without accepting',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const source = await context.newPage();
    await source.setContent('<h1>Private source</h1>');
    let allow = false;
    const engine = await BrowserProjection.attach(source, {
      authorize: () => true,
    });
    t.after(() => engine.close());
    const messages: ServerMessage[] = [];
    const watchMessages: ServerMessage[] = [];
    const observation = await engine.observe((m) => messages.push(m));
    const watcher = await engine.observe((m) => watchMessages.push(m));
    const control = await engine.acquireControl(observation, () => allow);
    const opened = new Promise<void>((resolve) =>
      source.once('dialog', () => resolve()),
    );
    const result = source.evaluate(() => confirm('Private confirmation'));
    await opened;
    // The adapter consumes the same source event on its single debugger session.
    for (let i = 0; i < 100 && !messages.some((m) => m.type === 'dialog'); ++i)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const state = messages.findLast((m) => m.type === 'dialog')!;
    assert.equal(state.type, 'dialog');
    assert.ok(state.dialog);
    assert.equal(
      watchMessages.some((m) => m.type === 'dialog'),
      false,
    );
    const command = {
      type: 'command' as const,
      id: 1,
      tab: engine.id,
      epoch: '',
      action: {
        kind: 'dialog_reply' as const,
        dialog: state.dialog.id,
        accept: true,
      },
    };
    await watcher.receive(command);
    assert.equal(
      watchMessages.findLast((m) => m.type === 'ack')?.code,
      'not_allowed',
    );
    await control.receive(command);
    assert.equal(
      messages.findLast((m) => m.type === 'ack')?.code,
      'not_allowed',
    );
    allow = true;
    await control.receive({
      ...command,
      id: 2,
      action: { ...command.action, dialog: 'obsolete-dialog' },
    });
    assert.equal(
      messages.findLast((m) => m.type === 'ack')?.code,
      'stale_view',
    );
    await control.close();
    assert.equal(await result, false);
    assert.equal(messages.findLast((m) => m.type === 'dialog')?.dialog, null);
    assert.equal(
      watchMessages.some((m) => m.type === 'dialog'),
      false,
    );
  },
);
