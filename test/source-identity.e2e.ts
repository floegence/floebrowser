import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { launchSourceBrowser } from '../dist/host/browser.js';

async function identity(page: Page) {
  return page.evaluate(async () => {
    const data = (navigator as any).userAgentData;
    return {
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      hints: await data.getHighEntropyValues([
        'architecture',
        'bitness',
        'platformVersion',
        'fullVersionList',
      ]),
    };
  });
}

test('source launch preserves native browser identity and client hints', async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Native browser identity</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const native = await chromium.launch({
    channel: 'chromium',
    headless: true,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
  t.after(() => native.close());
  const context = await native.newContext({ viewport: null });
  const reference = await context.newPage();
  await reference.goto(url);
  const expected = await identity(reference);
  const source = await launchSourceBrowser();
  t.after(() => source.close());
  const page = await source.newPage();
  await page.goto(url);
  const actual = await identity(page);
  assert.deepEqual(
    actual.hints,
    expected.hints,
    'Native platform and architecture must not be inferred from the reduced UA',
  );
  assert.equal(
    actual.userAgent,
    expected.userAgent,
    'The launch must not manufacture another browser identity',
  );
  assert.equal(
    actual.webdriver,
    expected.webdriver,
    'Source automation state is owned by Chromium',
  );
});
