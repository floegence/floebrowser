import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'copy uses the client clipboard for source-selected text in inputs and nested frames',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.route('http://copy.test/', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><input value="Hello copy 世界"><textarea>Selected lines</textarea><iframe src="http://copy-child.test/"></iframe>',
      }),
    );
    await context.route('http://copy-child.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><p>Nested selection</p>',
      }),
    );
    const source = await context.newPage();
    await source.goto('http://copy.test/');
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(() => service.close());
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(3000);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const copy = process.platform === 'darwin' ? 'Meta+c' : 'Control+c';
    await source.evaluate(() =>
      document.addEventListener('copy', (event) => event.preventDefault()),
    );
    const content = viewer.frameLocator('#viewport iframe');
    await viewer.evaluate(() => {
      (window as any).copies = [];
      const frame =
        document.querySelector<HTMLIFrameElement>('#viewport iframe')!;
      for (const doc of [
        frame.contentDocument!,
        frame.contentDocument!.querySelector('iframe')!.contentDocument!,
      ])
        doc.addEventListener('copy', (e) => {
          (window as any).copies.push({
            trusted: e.isTrusted,
            tag: (e.target as Element)?.tagName,
          });
          // Keep this regression independent of the developer's OS clipboard.
          e.preventDefault();
        });
    });
    await content.locator('input').click();
    await source.waitForFunction(
      () => document.activeElement?.tagName === 'INPUT',
    );
    await source
      .locator('input')
      .evaluate((node: HTMLInputElement) => node.setSelectionRange(6, 10));
    await viewer.waitForFunction(() => {
      const node = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector('input');
      return node?.selectionStart === 6 && node?.selectionEnd === 10;
    });
    await viewer.keyboard.press(copy);
    await viewer.waitForFunction(() => (window as any).copies.length === 1);
    assert.deepEqual(await viewer.evaluate(() => (window as any).copies[0]), {
      trusted: true,
      tag: 'INPUT',
    });
    await content.locator('textarea').click();
    await source.waitForFunction(
      () => document.activeElement?.tagName === 'TEXTAREA',
    );
    await source
      .locator('textarea')
      .evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 8));
    await viewer.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector('textarea')?.selectionEnd === 8,
    );
    await viewer.keyboard.press(copy);
    await viewer.waitForFunction(() => (window as any).copies.length === 2);
    const paragraph = content.frameLocator('iframe').locator('p');
    await paragraph.click({ clickCount: 2 });
    await viewer.keyboard.press(copy);
    await viewer.waitForFunction(() => (window as any).copies.length === 3);
    assert.equal(await source.locator('input').inputValue(), 'Hello copy 世界');
    assert.equal(
      await source.locator('textarea').inputValue(),
      'Selected lines',
    );
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);
