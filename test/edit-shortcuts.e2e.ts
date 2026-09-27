import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { clickProjected } from './projected-input.js';

for (const client of [chromium, firefox, webkit]) {
  for (const preventSelection of [false, true]) {
    test(
      `${client.name()} forwards Command+A with source-controlled selection (${preventSelection ? 'prevented' : 'allowed'})`,
      { timeout: 20000 },
      async (t) => {
        const browser = await chromium.launch();
        const viewerBrowser = await client.launch();
        t.after(() => Promise.all([browser.close(), viewerBrowser.close()]));
        const context = await browser.newContext();
        await context.route('http://edit.test/', (route) =>
          route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><input value="Initial text 世界"><textarea>Initial text 世界</textarea>',
          }),
        );
        const source = await context.newPage();
        await source.goto('http://edit.test/');
        await source.evaluate((prevent) => {
          document.querySelectorAll('input, textarea').forEach((element) => {
            const editor = element as HTMLInputElement | HTMLTextAreaElement;
            editor.dataset.selectKeys = '0';
            editor.dataset.edits = '0';
            editor.addEventListener('keydown', (event) => {
              if (event.metaKey && event.key.toLowerCase() === 'a') {
                editor.dataset.selectKeys = String(
                  Number(editor.dataset.selectKeys) + 1,
                );
                if (prevent) event.preventDefault();
              }
            });
            editor.addEventListener('input', () => {
              editor.dataset.edits = String(Number(editor.dataset.edits) + 1);
            });
          });
        }, preventSelection);
        const service = await createProjectionServer(source, {
          authorize: () => true,
        });
        t.after(() => service.close());
        const viewer = await viewerBrowser.newPage();
        viewer.setDefaultTimeout(3000);
        await viewer.goto(service.url);
        await viewer.locator('#status.live').waitFor();
        for (const selector of ['input', 'textarea']) {
          await clickProjected(
            viewer.frameLocator('#viewport iframe').locator(selector),
          );
          await source.waitForFunction(
            (tag) => document.activeElement?.tagName.toLowerCase() === tag,
            selector,
          );
          const original = await source
            .locator(selector)
            .evaluate((node: HTMLInputElement) => ({
              start: node.selectionStart,
              end: node.selectionEnd,
            }));
          // Exercise the Mac client gesture on every source platform. CDP does
          // not supply the native Command+A menu binding, even on macOS.
          await viewer.keyboard.press('Meta+a');
          await source.waitForFunction(
            (tag) =>
              document.querySelector<HTMLElement>(tag)?.dataset.selectKeys ===
              '1',
            selector,
          );
          if (preventSelection) {
            assert.deepEqual(
              await source
                .locator(selector)
                .evaluate((node: HTMLInputElement) => ({
                  start: node.selectionStart,
                  end: node.selectionEnd,
                })),
              original,
            );
            assert.equal(
              await source.locator(selector).inputValue(),
              'Initial text 世界',
            );
            assert.equal(
              await source.locator(selector).getAttribute('data-edits'),
              '0',
            );
          } else {
            await source.waitForFunction((tag) => {
              const input = document.querySelector<HTMLInputElement>(tag)!;
              return (
                input.selectionStart === 0 &&
                input.selectionEnd === input.value.length
              );
            }, selector);
            await viewer.keyboard.insertText('中文替换');
            await source.waitForFunction(
              (tag) =>
                document.querySelector<HTMLInputElement>(tag)!.value ===
                '中文替换',
              selector,
            );
            assert.equal(
              await source.locator(selector).getAttribute('data-edits'),
              '1',
            );
          }
          assert.equal(
            await source.locator(selector).getAttribute('data-select-keys'),
            '1',
          );
        }
        assert.equal(await viewer.locator('#toast').isVisible(), false);
      },
    );
  }
}
