import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

const fixture = `<!doctype html><style>
body{margin:24px;font:16px/1.5 Arial}object{color:rgb(20,70,100)}object > div{width:460px;padding:12px;border:1px solid #aaa}object[data=""] > span{font-weight:700}#scroll{height:80px;overflow:auto}#scroll p{margin:0;height:300px}
</style><object id="summary"><div><p id="text">Ordinary HTML summary inside an object.</p><button id="click" onclick="this.textContent='Clicked '+(++window.clicks)">Clicked 0</button><label>Name <input id="entry"></label><object id="nested" data=""><span>Nested fallback</span></object><div id="scroll"><p>Scrollable fallback content</p></div></div></object><script>window.clicks=0</script>`;

for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} projects resource-free object content with source layout, input and live changes`,
    { timeout: 20000 },
    async (t) => {
      const sourceBrowser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() =>
        Promise.all([sourceBrowser.close(), viewerBrowser.close()]),
      );
      const source = await sourceBrowser.newPage({
        viewport: { width: 1000, height: 700 },
      });
      await source.goto('data:text/html,' + encodeURIComponent(fixture));
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(() => service.close());
      const viewer = await viewerBrowser.newPage({
        viewport: { width: 1000, height: 800 },
      });
      viewer.setDefaultTimeout(4000);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const replay = viewer.frameLocator(
        '#viewport .floe-projection:not([aria-hidden]) iframe',
      );
      assert.equal(
        await replay.locator('[data-floebrowser-unsupported]').count(),
        0,
        'An HTML fallback is not a plugin or external document',
      );
      await replay.locator('#text').waitFor();
      const layout = (el: Element) => ({
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
        color: el.ownerDocument.defaultView!.getComputedStyle(el).color,
      });
      const expected = await source.locator('#summary > div').evaluate(layout);
      assert.deepEqual(
        await replay.locator('#summary > div').evaluate(layout),
        expected,
      );
      assert.equal(
        await replay
          .locator('#nested > span')
          .evaluate((el) => getComputedStyle(el).fontWeight),
        '700',
      );
      const click = (await replay.locator('#click').boundingBox())!;
      await viewer.mouse.click(
        click.x + click.width / 2,
        click.y + click.height / 2,
      );
      await source.waitForFunction(() => (window as any).clicks === 1);
      await replay.getByText('Clicked 1', { exact: true }).waitFor();
      const entry = (await replay.locator('#entry').boundingBox())!;
      await viewer.mouse.click(entry.x + 20, entry.y + entry.height / 2);
      await viewer.keyboard.insertText('Object fallback input');
      await source.waitForFunction(
        () =>
          (document.querySelector('#entry') as HTMLInputElement).value ===
          'Object fallback input',
      );
      const scroll = (await replay.locator('#scroll').boundingBox())!;
      await viewer.mouse.move(scroll.x + 30, scroll.y + 30);
      await viewer.mouse.wheel(0, 100);
      await source.waitForFunction(
        () => document.querySelector('#scroll')!.scrollTop > 0,
      );
      await source.evaluate(() => {
        document.querySelector('#text')!.textContent = 'Updated source summary';
        const next = document.createElement('object');
        next.id = 'added';
        next.innerHTML = '<span>Added fallback</span>';
        document.body.append(next);
      });
      await replay
        .getByText('Updated source summary', { exact: true })
        .waitFor();
      await replay.getByText('Added fallback', { exact: true }).waitFor();
      assert.equal(
        await replay.locator('object,embed,script').count(),
        0,
        'The viewer does not receive native embedding or script elements',
      );
      assert.equal(await viewer.locator('#toast').isVisible(), false);
    },
  );

for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} checkpoints object embedding changes without executing or fetching at the viewer`,
    { timeout: 25000 },
    async (t) => {
      const sourceBrowser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() =>
        Promise.all([sourceBrowser.close(), viewerBrowser.close()]),
      );
      const source = await sourceBrowser.newPage();
      await source.route('https://embedded.test/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<h1>External document</h1><script>parent.externalRuns=(parent.externalRuns||0)+1</script>',
        }),
      );
      await source.goto(
        'data:text/html,' +
          encodeURIComponent(
            `<object id="changing"><button id="inside" onclick="this.textContent='Source click'">Fallback</button><script>window.sourceRuns=1</script></object><object id="initial" data="https://embedded.test/initial"><span>Initially blocked fallback</span></object><embed src="https://embedded.test/plugin"><div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<object id="shadow-object"><span>Shadow fallback</span></object>'</script>`,
          ),
      );
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(() => service.close());
      const viewer = await viewerBrowser.newPage();
      viewer.setDefaultTimeout(4000);
      const externalRequests: string[] = [];
      const errors: string[] = [];
      viewer.on('pageerror', (error) => errors.push(error.message));
      await viewer.route('**/*', (route) => {
        if (
          new URL(route.request().url()).origin !== new URL(service.url).origin
        ) {
          externalRequests.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      await viewer.addInitScript(() => {
        (window as any).snapshots = [];
        const Original = window.WebSocket;
        window.WebSocket = class extends Original {
          constructor(...args: ConstructorParameters<typeof WebSocket>) {
            super(...args);
            this.addEventListener('message', (event) => {
              if (typeof event.data !== 'string') return;
              const message = JSON.parse(event.data);
              if (message.type === 'snapshot')
                (window as any).snapshots.push(message.epoch);
            });
          }
        };
      });
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      const replay = viewer.frameLocator(
        '#viewport .floe-projection:not([aria-hidden]) iframe',
      );
      await replay.locator('#inside').waitFor();
      await replay.getByText('Shadow fallback', { exact: true }).waitFor();
      assert.equal(
        await replay.locator('[data-floebrowser-unsupported]').count(),
        2,
      );
      const epochs = () =>
        viewer.evaluate(() => [...(window as any).snapshots]);
      const before = await epochs();
      await source.locator('#changing').evaluate((el) => {
        el.setAttribute('data', '');
        el.setAttribute('type', '');
        el.className = 'changed';
        el.querySelector('button')!.textContent = 'Ordinary update';
      });
      await replay.getByText('Ordinary update', { exact: true }).waitFor();
      assert.deepEqual(
        await epochs(),
        before,
        'Ordinary HTML edits preserve the current input epoch',
      );
      const modes = [
        {
          selector: '#changing',
          attribute: 'data',
          value: 'https://embedded.test/first',
          count: 3,
        },
        {
          selector: '#changing',
          attribute: 'data',
          value: null,
          count: 2,
          text: 'Ordinary update',
        },
        {
          selector: '#changing',
          attribute: 'type',
          value: 'text/html',
          count: 3,
        },
        {
          selector: '#changing',
          attribute: 'type',
          value: '',
          count: 2,
          text: 'Ordinary update',
        },
        {
          selector: '#initial',
          attribute: 'data',
          value: null,
          count: 1,
          text: 'Initially blocked fallback',
        },
        {
          selector: '#shadow-object',
          attribute: 'data',
          value: 'https://embedded.test/shadow',
          count: 2,
        },
        {
          selector: '#shadow-object',
          attribute: 'data',
          value: null,
          count: 1,
          text: 'Shadow fallback',
        },
      ];
      for (const mode of modes) {
        const previous = await epochs();
        await source
          .locator(mode.selector)
          .evaluate((el, { attribute, value }) => {
            if (value === null) el.removeAttribute(attribute);
            else el.setAttribute(attribute, value);
          }, mode);
        await viewer.waitForFunction(
          (count) => (window as any).snapshots.length > count,
          previous.length,
        );
        await viewer.waitForFunction((count) => {
          const doc = document.querySelector<HTMLIFrameElement>(
            '#viewport .floe-projection:not([aria-hidden]):not([inert]) iframe',
          )?.contentDocument;
          if (!doc) return false;
          const roots: (Document | ShadowRoot)[] = [doc];
          let total = 0;
          while (roots.length) {
            const root = roots.pop()!;
            total += root.querySelectorAll(
              '[data-floebrowser-unsupported]',
            ).length;
            for (const element of root.querySelectorAll('*'))
              if (element.shadowRoot) roots.push(element.shadowRoot);
          }
          return total === count;
        }, mode.count);
        if (mode.text)
          await replay.getByText(mode.text, { exact: true }).waitFor();
        const next = await epochs();
        assert.equal(
          next.length,
          previous.length + 1,
          'One mode transition produces one checkpoint',
        );
        assert.notEqual(
          next.at(-1),
          previous.at(-1),
          'A mode transition revokes old input authority',
        );
        assert.equal(await replay.locator('object,embed,script').count(), 0);
      }
      const bounds = (await replay.locator('#inside').boundingBox())!;
      await viewer.mouse.click(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await replay.getByText('Source click', { exact: true }).waitFor();
      assert.equal(await source.evaluate(() => (window as any).sourceRuns), 1);
      assert.equal(
        await replay
          .locator('body')
          .evaluate((el) => (el.ownerDocument.defaultView as any).sourceRuns),
        undefined,
      );
      assert.deepEqual(externalRequests, []);
      assert.deepEqual(errors, []);
      assert.equal(await viewer.locator('#toast').isVisible(), false);
    },
  );
