import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { clickProjected } from './projected-input.js';

for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} restores the caret when clicking an already focused field`,
    { timeout: 20000 },
    async (t) => {
      const sourceBrowser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() =>
        Promise.all([sourceBrowser.close(), viewerBrowser.close()]),
      );
      const source = await sourceBrowser.newPage();
      await source.goto(
        'data:text/html,<input autofocus style="width:400px;height:40px"><textarea style="width:400px;height:80px"></textarea>',
      );
      await source.locator('input').focus();
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(() => service.close());
      const viewer = await viewerBrowser.newPage();
      viewer.setDefaultTimeout(3000);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const content = viewer.frameLocator('#viewport iframe');
      for (const field of ['input', 'textarea']) {
        for (let click = 0; click < 2; click++) {
          await clickProjected(content.locator(field));
          await viewer.waitForFunction(() => {
            const proxy = document.querySelector('.floe-input-proxy');
            return (
              proxy &&
              document.activeElement === proxy &&
              getComputedStyle(proxy).visibility === 'visible'
            );
          });
          assert.equal(
            await source.locator(field).inputValue(),
            '',
            'Focusing must not enter text',
          );
        }
        await viewer.keyboard.insertText('Caret 世界');
        await source.waitForFunction(
          (field) =>
            (document.querySelector(field) as HTMLInputElement).value ===
            'Caret 世界',
          field,
        );
      }
      assert.equal(await viewer.locator('#toast').isVisible(), false);
    },
  );
