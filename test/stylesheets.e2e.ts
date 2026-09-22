import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'malformed cross-origin CSS preserves browser layout, imports and source-only images',
  { timeout: 20000 },
  async (t) => {
    let port = 0;
    const requests: string[] = [];
    // Real-world stylesheets can contain invalid declarations. Chromium ignores
    // those declarations while applying valid rules throughout the same sheet.
    const styles: Record<string, string> = {
      '/css/layout.css': `
        @import "./theme.css";
        body { margin: 0; background: rgb(240, 242, 244); }
        #before { display: flex; gap: 12px; }
        #legacy { width: 160px; width::564px; height: 60px; background: url(../image.svg); }
        #after { width: 240px; height: 36px; color: rgb(12, 34, 56); }
      `,
      '/css/widgets.css': `
        #tabs { width: 300px; height: 40px; zoom;1; padding: 1px 0; }
        #footer { display: grid; grid-template-columns: 80px 120px; }
        a { color: rgb(90, 90, 90); font-weight: 700; }
        a:link, a:visited { color: rgb(12, 34, 56); font-weight: 400; }
        a:any-link { display: inline-block; padding: 4px; }
        a:not(:any-link) { border-left: 3px solid; }
      `,
      '/css/theme.css': '#after { border-left: 7px solid rgb(10, 20, 30); }',
    };
    const site = createServer((request, response) => {
      const path = request.url!;
      requests.push(path);
      if (styles[path]) {
        response.writeHead(200, { 'Content-Type': 'text/css' });
        response.end(styles[path]);
      } else if (path === '/image.svg') {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42"><rect width="42" height="42" fill="green"/></svg>',
        );
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`<!doctype html><html><head>
          <link rel="stylesheet" href="http://localhost:${port}/css/layout.css">
          <link rel="stylesheet" href="http://localhost:${port}/css/widgets.css">
          <style>#inline { width: 190px; width::300px; height: 25px; }</style>
          </head><body><div id="before"><div id="legacy"></div><div id="after">After invalid declaration</div></div>
          <div id="tabs">Tabs</div><div id="footer"><span>First</span><span>Second</span></div>
          <div id="inline">Inline stylesheet</div><style id="dynamic"></style>
          <a id="link" href="#destination">Source link</a><a id="plain-anchor">Plain anchor</a>
          <img id="image" src="http://localhost:${port}/image.svg"></body></html>`);
      }
    });
    await new Promise<void>((resolve) => site.listen(0, resolve));
    t.after(() => new Promise<void>((resolve) => site.close(() => resolve())));
    port = (site.address() as AddressInfo).port;
    const browser = await chromium.launch({ chromiumSandbox: true });
    t.after(() => browser.close());
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      port: 0,
      authorize: () => true,
    });
    t.after(() => service.close());
    await source.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'networkidle',
    });
    const sourceRequests = requests.length;
    const viewer = await browser.newPage({
      viewport: { width: 1280, height: 884 },
    });
    const externalRequests: string[] = [];
    await viewer.route('**/*', (route) => {
      if (
        new URL(route.request().url()).origin !== new URL(service.url).origin
      ) {
        externalRequests.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const root = viewer.frameLocator('#viewport iframe');
    await root
      .locator('#image')
      .evaluate((image: HTMLImageElement) => image.decode());
    const geometry = () =>
      [
        'body',
        '#before',
        '#legacy',
        '#after',
        '#tabs',
        '#footer',
        '#inline',
        '#link',
        '#plain-anchor',
      ].map((selector) => {
        const node = document.querySelector(selector)!;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          selector,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          color: style.color,
          weight: style.fontWeight,
          background: style.backgroundColor,
          padding: style.padding,
          border: style.borderLeftWidth,
          display: style.display,
        };
      });
    const expected = await source.evaluate(geometry);
    // Await asset completion before comparing, so this detects missing rules,
    // rather than only a transient unstyled frame during normal loading.
    await root.locator('head').evaluate(async () => {
      await Promise.all(
        [
          ...document.querySelectorAll<HTMLLinkElement>(
            'link[rel="stylesheet"]',
          ),
        ].map((link) =>
          link.sheet
            ? Promise.resolve()
            : new Promise<void>((resolve) =>
                link.addEventListener('load', () => resolve(), { once: true }),
              ),
        ),
      );
    });
    assert.deepEqual(await root.locator('body').evaluate(geometry), expected);
    const background = await root
      .locator('#legacy')
      .evaluate((node) => getComputedStyle(node).backgroundImage);
    assert.match(background, /blob:/u);
    assert.equal(
      await root
        .locator('#image')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
      42,
    );
    await source.evaluate(() => {
      document.querySelector('#dynamic')!.textContent =
        '#after { width::400px; color: rgb(70, 80, 90); }';
    });
    const deadline = Date.now() + 4000;
    while (
      (await root
        .locator('#after')
        .evaluate((node) => getComputedStyle(node).color)) !==
        'rgb(70, 80, 90)' &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(
      await root.locator('body').evaluate(geometry),
      await source.evaluate(geometry),
    );
    assert.equal(await root.locator('#link').getAttribute('href'), null);
    for (const href of [null, '#destination']) {
      await source.locator('#link').evaluate((node, value) => {
        if (value === null) node.removeAttribute('href');
        else node.setAttribute('href', value);
      }, href);
      const expectedColor = await source
        .locator('#link')
        .evaluate((node) => getComputedStyle(node).color);
      const deadline = Date.now() + 4000;
      while (
        (await root
          .locator('#link')
          .evaluate((node) => getComputedStyle(node).color)) !==
          expectedColor &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(
        await root.locator('body').evaluate(geometry),
        await source.evaluate(geometry),
      );
      assert.equal(await root.locator('#link').getAttribute('href'), null);
    }
    assert.deepEqual(externalRequests, []);
    assert.equal(
      requests.length,
      sourceRequests,
      'Projection must reuse observed responses without refetching site resources',
    );
  },
);
