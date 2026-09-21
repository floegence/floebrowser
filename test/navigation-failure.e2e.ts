import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { launchSourceBrowser } from '../dist/host/browser.js';
import { createProjectionServer } from '../dist/host/server.js';
import { BrowserSession } from '../dist/host/session.js';
import type { ServerMessage } from '../src/shared/protocol.js';
import { fixture } from './fixture.js';

async function bounded<T>(work: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

test('a failed document navigation cannot stall source execution or controller release', async () => {
  const site = await fixture();
  const context = await launchSourceBrowser();
  const source = await context.newPage();
  await context.route(`${site.url}/unreachable`, (route) =>
    route.abort('connectionfailed'),
  );
  const session = await BrowserSession.attach(source, {
    authorize: () => true,
  });
  const messages: ServerMessage[] = [];
  let controller = await session.connect((m) => messages.push(m));
  try {
    await controller.receive({
      type: 'command',
      id: 1,
      tab: session.currentState.active,
      epoch: '',
      action: { kind: 'navigate', url: `${site.url}/unreachable` },
    });
    assert.equal(messages.findLast((m) => m.type === 'ack')?.ok, false);
    await bounded(
      source.title(),
      'The browser error document must remain responsive',
    );
    await bounded(
      controller.close(),
      'A failed page must release its controller',
    );
    controller = await bounded(
      session.connect((m) => messages.push(m)),
      'A failed page must allow reconnection',
    );
    await bounded(
      controller.receive({
        type: 'command',
        id: 2,
        tab: session.currentState.active,
        epoch: '',
        action: { kind: 'navigate', url: site.url },
      }),
      'A new address must recover the same source tab',
    );
    assert.equal(await source.title(), 'Workspace · Juniper');
  } finally {
    await context.close();
    await bounded(
      session.close(),
      'Session disposal must finish after the source closes',
    );
    await site.close();
  }
});

for (const failure of [
  'connectionfailed',
  'namenotresolved',
  'connectionreset',
] as const) {
  test(`failed navigation (${failure}) stays local to its tab and recovers through normal browser controls`, async (t) => {
    const site = await fixture();
    const context = await launchSourceBrowser();
    const source = await context.newPage();
    let blocked = true;
    let attempts = 0;
    const url = `${site.url}/unreachable`;
    await context.route(url, (route) => {
      attempts++;
      return blocked
        ? route.abort(failure)
        : route.fulfill({
            contentType: 'text/html',
            body: '<h1>Recovered site</h1>',
          });
    });
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    const viewer = await context.browser()!.newPage();
    viewer.setDefaultTimeout(5000);
    const disconnected: number[] = [];
    const errors: string[] = [];
    const external: string[] = [];
    viewer.on('pageerror', (error) => errors.push(error.message));
    viewer.on('websocket', (socket) =>
      socket.on('close', () => disconnected.push(Date.now())),
    );
    await viewer.route('**/*', (route) => {
      if (
        new URL(route.request().url()).origin !== new URL(service.url).origin
      ) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    t.after(async () => {
      await viewer.close();
      await service.close();
      await context.close();
      await site.close();
    });
    await source.goto(site.url);
    await viewer.goto(service.url);
    await viewer.frameLocator('#viewport iframe').locator('#count').waitFor();
    const original = service.session.currentState.active;
    if (failure === 'connectionreset') {
      await source.evaluate((url) => {
        const link = document.createElement('a');
        link.id = 'failed-popup';
        link.href = url;
        link.target = '_blank';
        link.textContent = 'Open a failing source tab';
        document.body.prepend(link);
      }, url);
      await viewer
        .frameLocator('#viewport iframe')
        .locator('#failed-popup')
        .click();
    } else {
      await viewer.locator('#new-tab').click();
      await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
      await viewer.locator('#address').fill(url);
      await viewer.locator('#address').press('Enter');
    }
    const failurePage = viewer.locator('.floe-page-error');
    await failurePage.waitFor();
    const failedTab = service.session.currentState.active;
    if (failure === 'connectionfailed') {
      await mkdir('.test-artifacts', { recursive: true });
      await viewer.screenshot({ path: '.test-artifacts/navigation-error.png' });
    }
    assert.equal(service.engine.currentState.status, 'error');
    assert.equal(service.engine.currentState.url, url);
    assert.equal(await viewer.locator('#address').inputValue(), url);
    assert.equal(
      await viewer.locator('#connection-overlay').isVisible(),
      false,
    );
    assert.equal(await viewer.locator('#address').isEnabled(), true);
    assert.equal(
      await viewer.locator('#toast').isVisible(),
      false,
      'The page error replaces the generic action-failure toast',
    );
    assert.equal(
      await viewer.locator('#viewport iframe').count(),
      0,
      'The old website must not remain on an error tab',
    );
    await viewer.locator(`[data-tab="${original}"]`).click();
    await viewer.frameLocator('#viewport iframe').locator('#count').click();
    await source.waitForFunction(
      () => document.querySelector('#count-value')?.textContent === '1',
    );
    await viewer.locator(`[data-tab="${failedTab}"]`).click();
    await failurePage.waitFor();
    assert.deepEqual(
      disconnected,
      [],
      'A site failure must not close the viewer connection',
    );
    await viewer.reload();
    await viewer.locator('.floe-page-error').waitFor();
    assert.equal(service.engine.currentState.url, url);
    assert.equal(
      attempts,
      1,
      'Switching and reconnecting must not replay the failed navigation',
    );
    blocked = false;
    await viewer
      .getByRole('button', { name: 'Reload page', exact: true })
      .click();
    await viewer
      .frameLocator('#viewport iframe')
      .getByRole('heading', { name: 'Recovered site' })
      .waitFor();
    assert.equal(
      attempts,
      2,
      'Only the explicit reload may request the website again',
    );
    assert.equal(await viewer.locator('.floe-page-error').isVisible(), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  });
}

test('a failed child frame leaves the main document and controller responsive', async () => {
  const site = await fixture();
  const context = await launchSourceBrowser();
  const source = await context.newPage();
  await context.route(`${site.url}/unreachable`, (route) =>
    route.abort('connectionfailed'),
  );
  await source.goto(site.url);
  const session = await BrowserSession.attach(source, {
    authorize: () => true,
  });
  let controller = await session.connect(() => {});
  try {
    const navigated = source.waitForEvent('framenavigated', {
      predicate: (frame) => frame !== source.mainFrame(),
    });
    await source.evaluate((url) => {
      const frame = document.createElement('iframe');
      frame.src = url;
      document.body.append(frame);
    }, `${site.url}/unreachable`);
    await navigated;
    await bounded(
      controller.close(),
      'An error frame must not block controller release',
    );
    controller = await bounded(
      session.connect(() => {}),
      'An error frame must not block a fresh snapshot',
    );
    assert.equal(session.activeProjection.currentState.status, 'ready');
    assert.equal(
      await bounded(source.title(), 'The main frame must remain responsive'),
      'Workspace · Juniper',
    );
  } finally {
    await context.close();
    await bounded(session.close(), 'Error frames must not block shutdown');
    await site.close();
  }
});

test('failed controller admission releases its provisional projection lease', async () => {
  const context = await launchSourceBrowser();
  const source = await context.newPage();
  const session = await BrowserSession.attach(source, {
    authorize: () => true,
  });
  try {
    await assert.rejects(
      session.connect((message) => {
        if (message.type === 'hello')
          throw new Error('Consumer rejected the handshake');
      }),
      /Consumer rejected the handshake/,
    );
    const messages: ServerMessage[] = [];
    let ready!: () => void;
    const snapshot = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const controller = await bounded(
      session.connect((message) => {
        messages.push(message);
        if (message.type === 'snapshot') ready();
      }),
      'A failed admission must not strand a source lease',
    );
    await bounded(snapshot, 'The recovered admission must produce fresh DOM');
    assert.ok(messages.some((message) => message.type === 'snapshot'));
    await controller.close();
  } finally {
    await session.close();
    await context.close();
  }
});

test('a failed tab admission rejects input promptly and allows another tab to take control', async () => {
  const context = await launchSourceBrowser();
  const source = await context.newPage();
  const session = await BrowserSession.attach(source, {
    authorize: () => true,
  });
  const messages: ServerMessage[] = [];
  let rejectHandshake = false;
  const controller = await session.connect((message) => {
    if (message.type === 'hello' && rejectHandshake) {
      rejectHandshake = false;
      throw new Error('Consumer rejected the new tab handshake');
    }
    messages.push(message);
  });
  const original = session.currentState.active;
  try {
    rejectHandshake = true;
    await controller.receive({
      type: 'command',
      id: 1,
      tab: original,
      epoch: '',
      action: { kind: 'tab_new' },
    });
    assert.equal(
      messages.findLast((m) => m.type === 'ack')?.code,
      'action_failed',
    );
    const failedTab = session.currentState.active;
    await controller.receive({
      type: 'command',
      id: 2,
      tab: failedTab,
      epoch: '',
      action: { kind: 'reload' },
    });
    assert.ok(
      messages.some(
        (m) => m.type === 'ack' && m.id === 2 && m.code === 'not_allowed',
      ),
      'Commands without an admitted controller must be rejected by the host grant',
    );
    await controller.receive({
      type: 'command',
      id: 3,
      tab: failedTab,
      epoch: '',
      action: { kind: 'tab_select', tab: original },
    });
    assert.equal(session.currentState.active, original);
    assert.equal(messages.findLast((m) => m.type === 'ack')?.ok, true);
    await controller.close();
  } finally {
    await session.close();
    await context.close();
  }
});

test('the standalone browser stays available when its initial website fails to load', async () => {
  const child = spawn(
    process.execPath,
    ['dist/host/cli.js', '--port', '0', '--url', 'http://127.0.0.1:1/'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  try {
    const url = await bounded(
      new Promise<string>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          const match = output.match(
            /http:\/\/127\.0\.0\.1:\d+\/session\/[\w-]+\//,
          );
          if (match) resolve(match[0]);
        });
        child.once('error', reject);
        child.once('exit', () =>
          reject(
            new Error(
              'The standalone host exited after a website failed to load',
            ),
          ),
        );
      }),
      'The viewer must start even when the initial address cannot load',
    );
    assert.equal((await fetch(url)).status, 200);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill('SIGTERM');
    await bounded(
      exited,
      'The standalone browser must shut down cleanly after a failed page load',
    );
  }
});
