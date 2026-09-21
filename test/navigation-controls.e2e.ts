import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'stopping a stalled navigation bypasses its wait, preserves the current page and remains authorized',
  { timeout: 15000 },
  async (t) => {
    const pending = new Set<ServerResponse>();
    const site = createServer((request, response) => {
      if (request.url === '/stall') {
        pending.add(response);
        response.on('close', () => pending.delete(response));
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<title>Navigation source</title><button onclick="this.textContent=\'Clicked\'">Current page</button>',
      );
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      for (const response of pending) response.end();
      site.closeAllConnections();
      return new Promise<void>((resolve) => site.close(() => resolve()));
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    await page.goto(url);
    let allowStop = true;
    const service = await createProjectionServer(page, {
      authorize: (action) => action.kind !== 'stop' || allowStop,
    });
    t.after(() => service.close());
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(4000);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await viewer.locator('#address').fill(`${url}stall`);
    await viewer.locator('#address').press('Enter');
    const stop = viewer.getByRole('button', {
      name: 'Stop loading',
      exact: true,
    });
    await stop.waitFor();
    assert.ok(pending.size);
    allowStop = false;
    await stop.click();
    await viewer
      .locator('#toast')
      .filter({ hasText: 'not authorize' })
      .waitFor();
    assert.ok(
      pending.size,
      'A rejected stop must leave the source navigation running',
    );
    await viewer.locator('#dismiss-toast').click();
    allowStop = true;
    const started = performance.now();
    await stop.click();
    await viewer
      .getByRole('button', { name: 'Reload source page', exact: true })
      .waitFor();
    assert.ok(
      performance.now() - started < 1500,
      'Stopping does not wait for the navigation timeout',
    );
    await clickProjected(
      viewer
        .frameLocator('#viewport iframe')
        .getByRole('button', { name: 'Current page', exact: true }),
    );
    await page.getByRole('button', { name: 'Clicked', exact: true }).waitFor();
    assert.equal(page.url(), url);
    assert.equal(
      await viewer.locator('#toast').isVisible(),
      false,
      'An intentional stop does not report navigation failure',
    );
  },
);
