import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'a complete cached tab appears before source selection and remains inert until fresh admission',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await context.route('https://cache.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<title>${new URL(route.request().url()).pathname}</title><style>button{width:160px;height:80px;background:rgb(24,120,80)}</style><button id=count onclick="this.textContent=String(++window.count)">${new URL(route.request().url()).pathname}</button><script>window.count=0</script>`,
      }),
    );
    const source = await context.newPage();
    await source.goto('https://cache.test/first');
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(5000);
    viewer.on('pageerror', (error) =>
      console.error('cache viewer', error.message),
    );
    await viewer.addInitScript(() => {
      const Native = WebSocket;
      (window as any).WebSocket = class extends Native {
        send(data: Parameters<WebSocket['send']>[0]) {
          if (
            typeof data === 'string' &&
            (window as any).holdSelection &&
            JSON.parse(data).action?.kind === 'tab_select'
          ) {
            (window as any).releaseSelection = () => {
              (window as any).holdSelection = false;
              super.send(data);
            };
            return;
          }
          super.send(data);
        }
      };
    });
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const replay = viewer.frameLocator('#viewport iframe');
    const settled = async () => {
      const handle = await viewer.waitForFunction(
        () =>
          !document
            .querySelector('#viewport')
            ?.parentElement?.classList.contains('switching'),
      );
      await handle.dispose();
    };
    await replay
      .locator('#count')
      .getByText('/first', { exact: true })
      .waitFor();
    await viewer.getByRole('button', { name: 'New tab', exact: true }).click();
    const address = viewer.getByRole('combobox', { name: 'Website address' });
    await address.fill('https://cache.test/second');
    await address.press('Enter');
    await replay
      .locator('#count')
      .getByText('/second', { exact: true })
      .waitFor();
    await viewer.locator('#status.live').waitFor();
    await viewer.evaluate(() => {
      (window as any).holdSelection = true;
    });
    await viewer.getByRole('tab', { name: '/first', exact: true }).click();
    const cached = await viewer.evaluate(
      () =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector('#count')?.textContent,
    );
    assert.equal(
      cached,
      '/first',
      'A warm cached document needs no source round trip',
    );
    const box = await replay.locator('#count').boundingBox();
    assert.ok(box);
    await viewer.mouse.click(box.x + 20, box.y + 20);
    assert.equal(
      await source.evaluate(() => (window as any).count),
      0,
      'The preview cannot execute stale input',
    );
    await viewer.evaluate(() => (window as any).releaseSelection());
    await settled();
    await replay.locator('#count').click();
    await source.waitForFunction(() => (window as any).count === 1, undefined, {
      timeout: 4000,
    });
    await viewer.getByRole('tab', { name: '/second', exact: true }).click();
    await replay
      .locator('#count')
      .getByText('/second', { exact: true })
      .waitFor();
    await viewer.locator('#status.live').waitFor();
    await settled();
    await source.goto('https://cache.test/third');
    await viewer.getByRole('tab', { name: '/third', exact: true }).waitFor();
    assert.equal(
      (
        await Promise.all(
          viewer.frames().map((frame) =>
            frame
              .locator('body')
              .innerText()
              .catch(() => ''),
          ),
        )
      ).some((text) => text === '1'),
      false,
      'Background navigation discards the prior document cache',
    );
    await source.close();
    await viewer
      .getByRole('tab', { name: '/third', exact: true })
      .waitFor({ state: 'detached' });
    assert.equal(
      await viewer.getByRole('tab').count(),
      1,
      'Closed sources cannot remain previewable',
    );
  },
);
