import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/index.js';

test(
  'embedded chrome preserves authenticated resource fetching and host colors',
  { timeout: 15000 },
  async (t) => {
    const site = http.createServer((request, response) => {
      response.setHeader(
        'Content-Type',
        request.url === '/image.svg' ? 'image/svg+xml' : 'text/html',
      );
      response.end(
        request.url === '/image.svg'
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="32"><rect width="44" height="32" fill="green"/></svg>'
          : '<!doctype html><title>Host resources</title><img id="picture" src="/image.svg">',
      );
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    t.after(() => {
      site.closeAllConnections();
      site.close();
    });
    const browser = await chromium.launch();
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const sourceURL = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
    await source.goto(sourceURL);
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
    import { mountBrowser, webSocketConnection } from './src/viewer/index.js';
    window.view = mountBrowser(document.body, {
      connect: () => { const url = new URL('stream', location.href); url.protocol='ws:'; return webSocketConnection(url.href); },
      fetchResource: (url, signal) => fetch(url, {signal, headers: {'X-Host-Resource': 'authorized'}}),
    });
    const chrome=document.querySelector('.floe-browser');
    for(const [key,value] of Object.entries({background:'#202223',foreground:'#f4f5f6',muted:'#afb4bc',line:'#505558',accent:'#bccbb8',surface:'#343738',field:'#303435'})) chrome.style.setProperty('--floe-'+key,value);
  `,
      },
      bundle: true,
      format: 'iife',
      write: false,
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(4000);
    await viewer.route('**/app.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: bundle.outputFiles[0]!.text,
      }),
    );
    const rejected: string[] = [];
    await viewer.route('**/assets/**', (route) => {
      if (route.request().headers()['x-host-resource'] !== 'authorized') {
        rejected.push(route.request().url());
        return route.fulfill({
          status: 403,
          body: 'Missing host authentication',
        });
      }
      return route.continue();
    });
    await viewer.goto(service.url);
    const address = viewer.getByRole('combobox');
    await address.fill(`${sourceURL}?keyboard`);
    await address.press('Enter');
    await source.waitForURL(`${sourceURL}?keyboard`, { timeout: 4000 });
    const picture = viewer.frameLocator('iframe').locator('#picture');
    await picture.waitFor();
    await viewer.waitForFunction(
      () =>
        document
          .querySelector('iframe')
          ?.contentDocument?.querySelector<HTMLImageElement>('#picture')
          ?.naturalWidth === 44,
    );
    assert.deepEqual(
      rejected,
      [],
      'Every resource uses the supplied host adapter',
    );
    await source.goto('about:blank');
    const welcome = viewer.locator('.welcome');
    await welcome.waitFor({ state: 'visible' });
    assert.equal(
      await welcome.evaluate((node) => getComputedStyle(node).backgroundColor),
      'rgb(32, 34, 35)',
    );
    assert.equal(
      await viewer
        .getByRole('combobox')
        .evaluate((node) => getComputedStyle(node).color),
      'rgb(244, 245, 246)',
    );
    await address.fill(sourceURL);
    await viewer
      .getByRole('button', { name: 'Open website', exact: true })
      .click();
    await source.waitForURL(sourceURL, { timeout: 4000 });
    await service.close();
    const overlay = viewer.locator('.connection-overlay');
    await overlay.waitFor({ state: 'visible' });
    assert.equal(
      await overlay.evaluate((node) => getComputedStyle(node).backgroundColor),
      'rgb(32, 34, 35)',
    );
  },
);
