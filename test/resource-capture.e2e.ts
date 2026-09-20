import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

async function fixture(t: test.TestContext, delayed = false) {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  if (!delayed) release();
  t.after(() => release());
  let assetPort = 0;
  const requests: string[] = [];
  const font = await readFile(
    'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2',
  );
  const assets = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Cache-Control', 'public, max-age=3600');
    if (request.url === '/style.css') {
      if (!request.headers.cookie?.includes('source-session=fixture')) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader('Content-Type', 'text/css');
      response.flushHeaders();
      void ready.then(() =>
        response.end(
          `@import './theme.css'; @font-face { font-family: CapturedFont; src: url('./font.woff2') } #panel { display: flex; gap: 12px; width: 400px; background: rgb(230,240,250); font-family: sans-serif; } #panel.custom { font-family: CapturedFont; } #picture { background-image: url('./image.svg'); width: 48px; height: 48px; }`,
        ),
      );
    } else if (request.url === '/theme.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end('#panel { border-left: 7px solid rgb(10,20,30); }');
    } else if (request.url === '/image.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="green"/></svg>',
      );
    } else if (request.url === '/font.woff2') {
      response.setHeader('Content-Type', 'font/woff2');
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end(font);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => assets.listen(0, '127.0.0.1', resolve));
  assetPort = (assets.address() as AddressInfo).port;
  const site = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/symbols.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.setHeader('Cache-Control', 'public, max-age=3600');
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect id="icon" width="24" height="24" fill="green"/></svg>',
      );
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.setHeader(
      'Set-Cookie',
      'source-session=fixture; HttpOnly; SameSite=Lax; Path=/',
    );
    response.end(
      `<!doctype html><title>Resource fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="http://127.0.0.1:${assetPort}/style.css"><div id="panel"><div id="picture"></div><span>Already loaded source content</span></div><img id="image" src="http://127.0.0.1:${assetPort}/image.svg"><svg width="24" height="24"><use id="symbol" href="/symbols.svg#icon"/></svg><script>window.sourceRuns=(window.sourceRuns||0)+1</script>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all(
      [site, assets].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });
  return {
    url: `http://127.0.0.1:${(site.address() as AddressInfo).port}/`,
    requests,
    release,
  };
}

async function verify(
  source: Page,
  viewer: Page,
  external: string[],
  verifyRequests: () => void,
) {
  await viewer.waitForFunction(
    () => {
      const doc =
        document.querySelector<HTMLIFrameElement>(
          '#viewport iframe',
        )?.contentDocument;
      const panel = doc?.querySelector('#panel');
      return (
        panel && doc!.defaultView!.getComputedStyle(panel).display === 'flex'
      );
    },
    undefined,
    { timeout: 3000 },
  );
  const projected = viewer.frameLocator('#viewport iframe');
  await viewer.waitForFunction(
    () => {
      const symbol = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector<SVGGraphicsElement>('#symbol');
      return symbol?.getBBox().width === 24;
    },
    undefined,
    { timeout: 3000 },
  );
  await projected
    .locator('#image')
    .evaluate((image: HTMLImageElement) => image.decode());
  verifyRequests();
  // Fonts decoded before attachment may have no remaining source bytes. Load
  // this face after attachment to exercise live capture alongside cached CSS.
  await source
    .locator('#panel')
    .evaluate((node) => node.classList.add('custom'));
  await projected.locator('#panel.custom').waitFor();
  await projected.locator('#panel').evaluate(async () => document.fonts.ready);
  const styles = (node: Element) => {
    const css = getComputedStyle(node);
    return {
      width: node.getBoundingClientRect().width,
      background: css.backgroundColor,
      border: css.borderLeftWidth,
      font: css.fontFamily,
    };
  };
  assert.deepEqual(
    await projected.locator('#panel').evaluate(styles),
    await source.locator('#panel').evaluate(styles),
  );
  assert.equal(
    await projected
      .locator('#image')
      .evaluate((image: HTMLImageElement) => image.naturalWidth),
    48,
  );
  assert.equal(
    await projected
      .locator('#panel')
      .evaluate(() =>
        [...document.fonts].some(
          (font) => font.family === 'CapturedFont' && font.status === 'loaded',
        ),
      ),
    true,
  );
  assert.match(
    await projected
      .locator('#picture')
      .evaluate((node) => getComputedStyle(node).backgroundImage),
    /\/session\/.*\/assets\//,
  );
  assert.equal(await source.evaluate(() => (window as any).sourceRuns), 1);
  assert.equal(
    await projected.locator('body').evaluate(() => (window as any).sourceRuns),
    undefined,
  );
  assert.deepEqual(external, []);
}

for (const mode of [
  'already loaded page',
  'cached popup waiting for tab admission',
  'page with a stylesheet still loading',
] as const) {
  test(
    `captures source resources from ${mode} without reloading or refetching`,
    { timeout: 15000 },
    async (t) => {
      const delayed = mode === 'page with a stylesheet still loading';
      const site = await fixture(t, delayed);
      const browser = await chromium.launch({ chromiumSandbox: true });
      t.after(() => browser.close());
      const context = await browser.newContext();
      const source = await context.newPage();
      const stylesheet = source.waitForResponse((response) =>
        response.url().endsWith('/style.css'),
      );
      await source.goto(site.url, {
        waitUntil: delayed ? 'commit' : 'networkidle',
      });
      await stylesheet;
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      t.after(() => release());
      const service = await createProjectionServer(source, {
        port: 0,
        authorize: async (action) => {
          if (mode.includes('popup') && action.kind === 'tab_new') {
            enter();
            await gate;
          }
          return true;
        },
      });
      t.after(() => service.close());
      site.release();
      const viewer = await browser.newPage();
      const external: string[] = [];
      await viewer.route('**/*', (route) => {
        if (
          new URL(route.request().url()).origin !== new URL(service.url).origin
        ) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      const beforeAttach = site.requests.length;
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      if (mode !== 'cached popup waiting for tab admission') {
        await verify(source, viewer, external, () =>
          assert.equal(
            site.requests.length,
            beforeAttach,
            'Attaching must not refetch or reload source content',
          ),
        );
      } else {
        await viewer
          .getByRole('button', { name: 'New tab', exact: true })
          .click();
        await entered;
        const opened = source.waitForEvent('popup');
        await source.evaluate(() => {
          window.open('/popup');
        });
        const popup = await opened;
        await popup.waitForLoadState('networkidle');
        await popup.evaluate(() => document.fonts.ready);
        const loaded = site.requests.length;
        release();
        await viewer.waitForFunction(() =>
          document
            .querySelector<HTMLInputElement>('#address')
            ?.value.endsWith('/popup'),
        );
        await verify(popup, viewer, external, () =>
          assert.equal(
            site.requests.length,
            loaded,
            'Adopting the cached popup must not refetch its resources',
          ),
        );
        assert.equal(await viewer.getByRole('tab').count(), 3);
      }
    },
  );
}
