import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

async function fixture(t: test.TestContext, mode = '') {
  let port = 0;
  const font = await readFile(
    new URL(
      '../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2',
      import.meta.url,
    ),
  );
  const site = createServer((request, response) => {
    if (request.url === '/font.woff2') {
      response.writeHead(200, {
        'Content-Type': 'font/woff2',
        'Access-Control-Allow-Origin': '*',
      });
      response.end(font);
    } else if (request.url === '/layout.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end(
        '@import "./nested.css"; #card { width: 320px; height: 80px; display: grid; }',
      );
    } else if (request.url === '/nested.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end('#card { background: rgb(10, 80, 160); padding: 24px; }');
    } else if (request.url === '/plain') {
      response.end(
        '<!doctype html><title>Plain page</title><button id="healthy" onclick="this.textContent=\'Clicked\'">Healthy page</button>',
      );
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      const assets = request.headers.host?.startsWith('localhost')
        ? '127.0.0.1'
        : 'localhost';
      const content = `<link rel="stylesheet" href="http://${assets}:${port}/layout.css"><button id="card" onclick="this.textContent='Clicked'">Styled content</button>`;
      response.end(
        request.url === '/shadow'
          ? `<!doctype html><title>Shadow page</title><div id="host"></div><script>host.attachShadow({mode:'open'}).innerHTML=${JSON.stringify(content)}</script>`
          : request.url === '/font'
            ? `<!doctype html><title>Font page</title><style>@font-face { font-family: Fixture; src: url('/font.woff2') } #card { font: 40px Fixture; }</style><p id="card">Font-dependent layout</p>`
            : `<!doctype html><title>Styled page</title>${content}`,
      );
    }
  });
  await new Promise<void>((resolve) => site.listen(0, resolve));
  port = (site.address() as AddressInfo).port;
  const browser = await chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext();
  const source = await context.newPage();
  const service = await createProjectionServer(source, {
    authorize: () => true,
  });
  const viewer = await browser.newPage();
  viewer.setDefaultTimeout(4000);
  t.after(async () => {
    await browser.close();
    await service.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${port}`;
  await source.goto(`${url}/${mode}`);
  return { source, service, viewer, url };
}

async function gateAssets(viewer: import('playwright').Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const loading = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await viewer.route('**/assets/**', async (route) => {
    requested();
    await gate;
    await route.continue().catch(() => {});
  });
  return { loading, release };
}

async function painted(viewer: import('playwright').Page) {
  await viewer.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

for (const mode of ['shadow', 'font'])
  test(
    `initial ${mode} content waits for its layout resources`,
    { timeout: 15000 },
    async (t) => {
      const { viewer, service } = await fixture(t, mode);
      const gate = await gateAssets(viewer);
      t.after(gate.release);
      await viewer.goto(service.url);
      await gate.loading;
      const card = viewer.frameLocator('#viewport iframe').locator('#card');
      await card.waitFor({ state: 'attached' });
      await painted(viewer);
      assert.equal(
        await card.evaluate((node) =>
          node.checkVisibility({ checkOpacity: true }),
        ),
        false,
      );
      gate.release();
      await viewer.locator('#status.live').waitFor();
      assert.equal(
        await card.evaluate((node) =>
          node.checkVisibility({ checkOpacity: true }),
        ),
        true,
      );
      if (mode === 'font')
        assert.equal(
          await card.evaluate(() => document.fonts.check('40px Fixture')),
          true,
        );
      else
        assert.equal(
          await card.evaluate((node) => getComputedStyle(node).backgroundColor),
          'rgb(10, 80, 160)',
        );
    },
  );

for (const replace of [false, true])
  test(
    `${replace ? 'Replaced' : 'Late'} cross-origin frame DOM remains hidden until its styles are ready`,
    { timeout: 15000 },
    async (t) => {
      const { source, viewer, service, url } = await fixture(t, 'plain');
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      if (replace) {
        await source.evaluate((url) => {
          const frame = document.createElement('iframe');
          frame.id = 'child';
          frame.src = url.replace('127.0.0.1', 'localhost') + '/plain';
          document.body.append(frame);
        }, url);
        await viewer
          .frameLocator('#viewport iframe')
          .frameLocator('#child')
          .locator('#healthy')
          .waitFor();
      }
      const gate = await gateAssets(viewer);
      t.after(gate.release);
      await source.evaluate((url) => {
        const frame =
          document.querySelector<HTMLIFrameElement>('#child') ??
          document.createElement('iframe');
        frame.id = 'child';
        frame.src = url.replace('127.0.0.1', 'localhost');
        if (!frame.isConnected) document.body.append(frame);
      }, url);
      await Promise.race([
        gate.loading,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Child stylesheet was not requested')),
            4000,
          ),
        ),
      ]);
      const card = viewer
        .frameLocator('#viewport iframe')
        .frameLocator('#child')
        .locator('#card');
      await card.waitFor({ state: 'attached' });
      await painted(viewer);
      assert.equal(
        await card.evaluate((node) =>
          node.checkVisibility({ checkOpacity: true }),
        ),
        false,
      );
      gate.release();
      await viewer.waitForFunction(() => {
        const root =
          document.querySelector<HTMLIFrameElement>(
            '#viewport iframe',
          )?.contentDocument;
        const node = root
          ?.querySelector<HTMLIFrameElement>('#child')
          ?.contentDocument?.querySelector('#card');
        return node?.checkVisibility({ checkOpacity: true });
      });
      assert.equal(
        await card.evaluate((node) =>
          node.checkVisibility({ checkOpacity: true }),
        ),
        true,
      );
      assert.equal(
        await card.evaluate((node) => getComputedStyle(node).backgroundColor),
        'rgb(10, 80, 160)',
      );
    },
  );

test(
  'switching away from pending styles cancels presentation without reviving the old tab',
  { timeout: 15000 },
  async (t) => {
    const { source, viewer, service, url } = await fixture(t, 'plain');
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const original = service.session.currentState.active;
    await viewer.locator('#new-tab').click();
    await viewer.waitForFunction(
      () => document.querySelectorAll('[role=tab]').length === 2,
    );
    await viewer.locator('#status.live').waitFor();
    const gate = await gateAssets(viewer);
    t.after(gate.release);
    await viewer.locator('#address').fill(url);
    await viewer.locator('#address').press('Enter');
    await gate.loading;
    await viewer
      .frameLocator('#viewport iframe')
      .locator('#card')
      .waitFor({ state: 'attached' });
    await viewer.locator(`[data-tab="${original}"]`).click();
    await viewer.locator('#status.live').waitFor();
    const healthy = viewer.frameLocator('#viewport iframe').locator('#healthy');
    await healthy.click();
    await source.waitForFunction(
      () => document.querySelector('#healthy')?.textContent === 'Clicked',
    );
    gate.release();
    await painted(viewer);
    assert.equal(service.session.currentState.active, original);
    assert.equal(await healthy.isVisible(), true);
    assert.equal(
      await viewer.locator('#connection-overlay').isVisible(),
      false,
    );
  },
);

test(
  'failed stylesheet imports settle without stranding browser controls',
  { timeout: 15000 },
  async (t) => {
    const { viewer, service } = await fixture(t);
    await viewer.route('**/assets/**', (route) => route.abort());
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    assert.equal(await viewer.locator('#new-tab').isEnabled(), true);
    assert.equal(
      await viewer
        .frameLocator('#viewport iframe')
        .locator('#card')
        .evaluate((node) => node.checkVisibility({ checkOpacity: true })),
      true,
    );
  },
);

test(
  'an unavailable font uses fallback text without holding the page indefinitely',
  { timeout: 15000 },
  async (t) => {
    const { viewer, service } = await fixture(t, 'font');
    const gate = await gateAssets(viewer);
    t.after(gate.release);
    await viewer.goto(service.url);
    await gate.loading;
    await viewer.locator('#status.live').waitFor({ timeout: 1500 });
    assert.equal(
      await viewer
        .frameLocator('#viewport iframe')
        .locator('#card')
        .evaluate((node) => node.checkVisibility({ checkOpacity: true })),
      true,
    );
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);

test(
  'stylesheet preparation has bounded recovery and keeps tab controls available',
  { timeout: 15000 },
  async (t) => {
    const { viewer, service } = await fixture(t);
    await viewer.addInitScript(() => {
      const original = window.setTimeout;
      window.setTimeout = ((
        handler: TimerHandler,
        delay?: number,
        ...args: any[]
      ) =>
        original(
          handler,
          delay === 10000 ? 300 : delay,
          ...args,
        )) as typeof setTimeout;
    });
    const gate = await gateAssets(viewer);
    t.after(gate.release);
    await viewer.goto(service.url);
    await gate.loading;
    await viewer.locator('#status.live').waitFor({ timeout: 1500 });
    assert.match(
      await viewer.locator('#toast').innerText(),
      /styles.*too long/,
    );
    await viewer.locator('#new-tab').click();
    await viewer.waitForFunction(
      () => document.querySelectorAll('[role=tab]').length === 2,
    );
    await viewer.locator('#status.live').waitFor();
    assert.equal(
      await viewer.locator('#connection-overlay').isVisible(),
      false,
    );
  },
);

test(
  'tab activation never exposes DOM before cross-origin and nested styles finish loading',
  { timeout: 15000 },
  async (t) => {
    const { source, service, viewer } = await fixture(t);
    await viewer.addInitScript(`window.unstyledFrames = 0;
      requestAnimationFrame(function sample() {
        const frame = document.querySelector('#viewport iframe');
        const card = frame?.contentDocument?.querySelector('#card');
        if (frame?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && card?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && frame.contentWindow.getComputedStyle(card).backgroundColor !== 'rgb(10, 80, 160)') window.unstyledFrames++;
        requestAnimationFrame(sample);
      });`);
    await viewer.goto(service.url);
    const card = viewer.frameLocator('#viewport iframe').locator('#card');
    await card.waitFor();
    await viewer.waitForFunction(() => {
      const doc =
        document.querySelector<HTMLIFrameElement>(
          '#viewport iframe',
        )?.contentDocument;
      const node = doc?.querySelector('#card');
      return (
        node &&
        doc?.defaultView?.getComputedStyle(node).backgroundColor ===
          'rgb(10, 80, 160)'
      );
    });
    const original = service.session.currentState.active;
    await viewer.locator('#new-tab').click();
    await viewer.waitForFunction(
      () => document.querySelectorAll('[role=tab]').length === 2,
    );
    await viewer.locator('#status.live').waitFor();
    assert.notEqual(service.session.currentState.active, original);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let requested!: () => void;
    const loading = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await viewer.route('**/assets/**', async (route) => {
      requested();
      await gate;
      await route.continue().catch(() => {});
    });
    await viewer.locator(`[data-tab="${original}"]`).click();
    await loading;
    await card.waitFor({ state: 'attached' });
    await viewer.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.equal(
      await card.evaluate((node) =>
        node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      ),
      false,
      'Unstyled DOM must stay hidden until its styles are applied',
    );
    assert.equal(await viewer.locator('#new-tab').isEnabled(), true);
    assert.equal(
      await viewer.locator('#connection-overlay').isVisible(),
      false,
    );
    release();
    await viewer.locator('#status.live').waitFor();
    assert.equal(await card.isVisible(), true);
    assert.equal(
      await card.evaluate((node) => getComputedStyle(node).backgroundColor),
      'rgb(10, 80, 160)',
    );
    await card.click();
    await source.waitForFunction(
      () => document.querySelector('#card')?.textContent === 'Clicked',
    );
    assert.equal(
      await viewer.evaluate(() => (window as any).unstyledFrames),
      0,
      'Every exposed frame must have its source styles',
    );
  },
);
