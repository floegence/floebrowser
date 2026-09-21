import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} copies source-selected text through trusted host clipboard events`,
    { timeout: 15000 },
    async (t) => {
      const browser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() => Promise.all([browser.close(), viewerBrowser.close()]));
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
      const viewer = await viewerBrowser.newPage();
      viewer.setDefaultTimeout(3000);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const copy = process.platform === 'darwin' ? 'Meta+c' : 'Control+c';
      await source.evaluate(() => {
        (window as any).sourceCopies = 0;
        document.addEventListener('copy', (event) => {
          (window as any).sourceCopies++;
          event.preventDefault();
        });
      });
      const content = viewer.frameLocator('#viewport iframe');
      await viewer.evaluate(() => {
        (window as any).copies = [];
        document.addEventListener(
          'copy',
          (event) => {
            // Intercept the event's output before the view handles it; exercise a
            // real keyboard gesture without changing the developer's clipboard.
            Object.defineProperty(event.clipboardData, 'setData', {
              value(format: string, text: string) {
                (window as any).copies.push({
                  trusted: event.isTrusted,
                  format,
                  text,
                });
              },
            });
            event.preventDefault();
          },
          true,
        );
      });
      await clickProjected(content.locator('input'));
      await source.waitForFunction(
        () => document.activeElement?.tagName === 'INPUT',
      );
      await source
        .locator('input')
        .evaluate((node: HTMLInputElement) => node.setSelectionRange(6, 10));
      await viewer.waitForFunction(() => {
        const node =
          document.querySelector<HTMLInputElement>('.floe-input-proxy');
        return node?.selectionStart === 6 && node?.selectionEnd === 10;
      });
      await viewer.keyboard.press(copy);
      await viewer.waitForFunction(() => (window as any).copies.length === 1);
      await clickProjected(content.locator('textarea'));
      await source.waitForFunction(
        () => document.activeElement?.tagName === 'TEXTAREA',
      );
      await source
        .locator('textarea')
        .evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 8));
      await viewer.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>('.floe-input-proxy')
            ?.selectionEnd === 8,
      );
      await viewer.keyboard.press(copy);
      await viewer.waitForFunction(() => (window as any).copies.length === 2);
      await clickProjected(content.frameLocator('iframe').locator('p'), {
        clickCount: 3,
      });
      await viewer.waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>('#viewport iframe')
            ?.contentDocument?.querySelector('iframe')
            ?.contentDocument?.getSelection()
            ?.toString()
            .trim() === 'Nested selection',
      );
      await viewer.keyboard.press(copy);
      await viewer.waitForFunction(() => (window as any).copies.length === 3);
      assert.deepEqual(
        await viewer.evaluate(() =>
          (window as any).copies.map((copy: any) => ({
            ...copy,
            text: copy.text.trim(),
          })),
        ),
        [
          { trusted: true, format: 'text/plain', text: 'copy' },
          { trusted: true, format: 'text/plain', text: 'Selected' },
          { trusted: true, format: 'text/plain', text: 'Nested selection' },
        ],
      );
      assert.equal(
        await source.evaluate(() => (window as any).sourceCopies),
        0,
      );
      assert.equal(
        await source.locator('input').inputValue(),
        'Hello copy 世界',
      );
      assert.equal(
        await source.locator('textarea').inputValue(),
        'Selected lines',
      );
      assert.equal(await viewer.locator('#toast').isVisible(), false);
    },
  );
