import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { PlaywrightSourceBrowser } from '../dist/host/playwright-source.js';
import type { SessionConnection } from '../src/host/session.js';

for (const engine of [chromium, firefox, webkit])
  for (const admission of ['standalone', 'host', 'observer'] as const)
    test(
      `${engine.name()} ${admission}: first tab presentation has settled geometry`,
      { timeout: 40000 },
      async (t) => {
        const sourceBrowser = await chromium.launch();
        const context = await sourceBrowser.newContext({
          viewport: { width: 900, height: 650 },
        });
        await context.route('https://tab-sizing.test/**', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><title>${new URL(route.request().url()).pathname.slice(1)}</title><style>body{margin:0;background:#185f8e;color:white}#edge{position:fixed;right:0;bottom:0;width:40px;height:40px;background:orange}</style><h1>${new URL(route.request().url()).pathname.slice(1)}</h1><button onclick="this.textContent='Clicked'">Action</button><div id="edge"></div>`,
          }),
        );
        const sources = [];
        for (let i = 0; i < 5; i++) {
          const page = await context.newPage();
          await page.goto(`https://tab-sizing.test/page-${i}`);
          sources.push(page);
        }
        const owner = new PlaywrightSourceBrowser();
        const entries = await Promise.all(
          sources.map(async (source) => ({
            page: await owner.adopt(source),
            title: await source.title(),
          })),
        );
        const unavailable = async () => {
          throw new Error('No directory mutation in this fixture');
        };
        const service = await createProjectionServer(
          {
            list: () => entries,
            subscribe: () => () => {},
            create: unavailable,
            close: unavailable,
            pin: unavailable,
            move: unavailable,
            restore: unavailable,
          },
          { authorize: () => true },
        );
        let connection: SessionConnection | undefined;
        const connect = service.session.connect.bind(service.session);
        const timers = new Set<ReturnType<typeof setTimeout>>();
        service.session.connect = async (send, options) => {
          const publish: typeof send = (message) => {
            // The directory acknowledgement and host grant can arrive after the
            // snapshot. A product result may also precede its separate DOM lane.
            if (
              message.type === 'ack' ||
              (admission === 'host' &&
                message.type === 'control' &&
                message.active)
            ) {
              const timer = setTimeout(() => {
                timers.delete(timer);
                void send(message);
              }, 140);
              timers.add(timer);
            } else return send(message);
          };
          connection =
            admission === 'standalone'
              ? await connect(publish, options)
              : await service.session.observe(publish, options);
          if (admission !== 'standalone') {
            connection.setDirectoryAuthority(() => true);
            const receive = connection.receive.bind(connection);
            connection.receive = async (message) => {
              if (
                message.type === 'command' &&
                message.action.kind === 'tab_select'
              )
                await connection!.releaseControl();
              await receive(message);
            };
          }
          return connection;
        };
        const browser = await engine.launch();
        t.after(async () => {
          for (const timer of timers) clearTimeout(timer);
          await service.close();
          await browser.close();
          await owner.dispose();
          await sourceBrowser.close();
        });
        const viewer = await browser.newPage({
          viewport: { width: 1440, height: 960 },
        });
        viewer.setDefaultTimeout(6000);
        await viewer.exposeFunction('admit', async (target: string) => {
          assert.equal(connection?.currentState.active, target);
          if (admission === 'observer') return false;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return connection!.acquireControl(() => true);
        });
        const bundle = await build({
          stdin: {
            resolveDir: process.cwd(),
            contents: `
        import { mountBrowser, webSocketConnection } from './src/viewer/index.js';
        window.preparations=[];
        window.browser=mountBrowser(document.body, { idPrefix: '',
          connect:()=>{const url=new URL('stream',location.href);url.protocol='ws:';return webSocketConnection(url.href)},
          ${admission === 'standalone' ? '' : 'onPrepareView: async(target,signal)=>{window.preparations.push(target);return window.admit(target)},'}
        });`,
          },
          bundle: true,
          format: 'iife',
          write: false,
        });
        await viewer.route('**/app.js', (route) =>
          route.fulfill({
            contentType: 'text/javascript',
            body: bundle.outputFiles[0]!.text,
          }),
        );
        await viewer.addInitScript(() => {
          (window as any).__name = (fn: unknown) => fn;
        });
        await viewer.goto(service.url);
        await viewer.locator('#status.live').waitFor();
        await viewer.evaluate(() => {
          (window as any).geometryFrames = [];
          const sample = () => {
            const viewport = document
              .querySelector('#viewport')!
              .getBoundingClientRect();
            const frame = [
              ...document.querySelectorAll<HTMLIFrameElement>(
                '#viewport iframe',
              ),
            ].find((frame) =>
              frame.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }),
            );
            const rect = frame?.getBoundingClientRect();
            const edge = frame?.contentDocument
              ?.querySelector('#edge')
              ?.getBoundingClientRect();
            if (!(window as any).geometryPaused)
              (window as any).geometryFrames.push({
                name: frame?.contentDocument?.querySelector('h1')?.textContent,
                x: rect && rect.x - viewport.x,
                y: rect && rect.y - viewport.y,
                width: rect?.width,
                height: rect?.height,
                innerWidth: frame?.contentWindow?.innerWidth,
                innerHeight: frame?.contentWindow?.innerHeight,
                edgeX: edge?.right,
                edgeY: edge?.bottom,
                viewport: { width: viewport.width, height: viewport.height },
              });
            (window as any).sampling = requestAnimationFrame(sample);
          };
          (window as any).sampling = requestAnimationFrame(sample);
        });
        for (const name of [
          'page-1',
          'page-2',
          'page-3',
          'page-4',
          'page-0',
          'page-4',
        ]) {
          await viewer.getByRole('tab', { name, exact: true }).click();
          await viewer.waitForFunction(
            (name) =>
              document.querySelector('#status.live') &&
              !document
                .querySelector('#viewport')
                ?.parentElement?.classList.contains('switching') &&
              [
                ...document.querySelectorAll<HTMLIFrameElement>(
                  '#viewport iframe',
                ),
              ].some(
                (frame) =>
                  frame.checkVisibility({
                    checkOpacity: true,
                    checkVisibilityCSS: true,
                  }) &&
                  frame.contentDocument?.querySelector('h1')?.textContent ===
                    name,
              ),
            name,
          );
          await viewer.waitForTimeout(200);
        }
        if (admission === 'host') {
          await connection!.setVisible(false);
          await connection!.setVisible(true);
          await viewer.waitForFunction(
            () =>
              (window as any).preparations.length === 8 &&
              document.querySelector('#status.live'),
          );
        }
        // A preview prepared for a previous window size must not briefly
        // replace the currently fitted document after the window is resized.
        await viewer.evaluate(() => {
          (window as any).geometryPaused = true;
        });
        await viewer.setViewportSize({ width: 1100, height: 800 });
        await viewer.waitForFunction((observer) => {
          const frame =
            document.querySelector<HTMLIFrameElement>('#viewport iframe');
          const box = document
            .querySelector('#viewport')!
            .getBoundingClientRect();
          const rect = frame?.getBoundingClientRect();
          return (
            rect &&
            Math.abs(
              rect.x - box.x - (observer ? (box.width - rect.width) / 2 : 0),
            ) < 1 &&
            Math.abs(
              rect.y - box.y - (observer ? (box.height - rect.height) / 2 : 0),
            ) < 1 &&
            Math.abs(
              rect.width -
                (observer
                  ? Math.min(900, box.width, (box.height * 900) / 650)
                  : box.width),
            ) < 1 &&
            Math.abs(
              rect.height -
                (observer
                  ? Math.min(650, box.height, (box.width * 650) / 900)
                  : box.height),
            ) < 1
          );
        }, admission === 'observer');
        await viewer.evaluate(() => {
          (window as any).geometryPaused = false;
        });
        await viewer.getByRole('tab', { name: 'page-0', exact: true }).click();
        await viewer.waitForFunction(
          () =>
            document.querySelector('#status.live') &&
            !document
              .querySelector('#viewport')
              ?.parentElement?.classList.contains('switching') &&
            document
              .querySelector<HTMLIFrameElement>('#viewport iframe')
              ?.contentDocument?.querySelector('h1')?.textContent === 'page-0',
        );
        await viewer.waitForTimeout(200);
        const frames = await viewer.evaluate(() => {
          cancelAnimationFrame((window as any).sampling);
          return (window as any).geometryFrames;
        });
        assert.ok(frames.length > 20);
        for (const frame of frames) {
          assert.ok(frame.name, 'Switching must retain painted content');
          const { width, height } = frame.viewport;
          const scale = Math.min(1, width / 900, height / 650);
          const expected =
            admission === 'observer'
              ? {
                  x: (width - 900 * scale) / 2,
                  y: (height - 650 * scale) / 2,
                  width: 900 * scale,
                  height: 650 * scale,
                  innerWidth: 900,
                  innerHeight: 650,
                  edgeX: 900,
                  edgeY: 650,
                }
              : {
                  x: 0,
                  y: 0,
                  width,
                  height,
                  innerWidth: width,
                  innerHeight: height,
                  edgeX: width,
                  edgeY: height,
                };
          for (const [key, value] of Object.entries(expected))
            assert.ok(
              Math.abs(frame[key] - value) < 1,
              `${frame.name} ${key}: ${frame[key]} expected ${value}; ${JSON.stringify(frame)}`,
            );
        }
        if (admission !== 'standalone')
          assert.equal(
            await viewer.evaluate(() => (window as any).preparations.length),
            admission === 'host' ? 9 : 8,
            'Admission runs once per selection and once after a revoked lease resumes',
          );
        if (admission !== 'observer') {
          await viewer
            .frameLocator('#viewport iframe')
            .getByRole('button', { name: 'Action' })
            .click();
          await sources[0]!.getByRole('button', { name: 'Clicked' }).waitFor();
        } else
          assert.deepEqual(
            sources.map((page) => page.viewportSize()),
            sources.map(() => ({ width: 900, height: 650 })),
          );
      },
    );

test(
  'host preparation cancels with selection and destruction; a late result cannot present the previous target',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const source = await context.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    service.session.connect = async (send, options) => {
      const connection = await service.session.observe(send, options);
      connection.setDirectoryAuthority(() => true);
      return connection;
    };
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
    import { mountBrowser, webSocketConnection } from './src/viewer/index.js';
    window.preparations=[];
    window.browser=mountBrowser(document.body, { idPrefix:'',
      connect:()=>{const url=new URL('stream',location.href);url.protocol='ws:';return webSocketConnection(url.href)},
      onTakeControl:()=>{throw new Error('Explicit takeover unavailable in this fixture')},
      onPrepareView:(target,signal)=>new Promise((resolve,reject)=>window.preparations.push({target,signal,resolve,reject}))
    });`,
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
    await viewer.goto(service.url);
    await viewer.waitForFunction(
      () => (window as any).preparations.length === 1,
    );
    assert.equal(await viewer.locator('#status.live').count(), 0);
    assert.equal(
      await viewer.evaluate(() =>
        (window as any).browser.dispatch({ kind: 'tab_new' }),
      ),
      true,
    );
    await viewer.waitForFunction(
      () => (window as any).preparations.length === 2,
    );
    assert.equal(
      await viewer.evaluate(
        () => (window as any).preparations[0].signal.aborted,
      ),
      true,
    );
    await viewer.evaluate(() => (window as any).preparations[0].resolve(true));
    await viewer.waitForTimeout(100);
    assert.equal(
      await viewer.locator('#status.live').count(),
      0,
      'A retired admission must not finish the current presentation',
    );
    await viewer.evaluate(() =>
      (window as any).preparations[1].reject(new Error('Idle control denied')),
    );
    await viewer.locator('#status.live').waitFor();
    await viewer
      .getByRole('button', { name: 'Take control', exact: true })
      .waitFor();
    assert.equal(
      await viewer.evaluate(() =>
        (window as any).browser.dispatch({ kind: 'tab_new' }),
      ),
      true,
    );
    await viewer.waitForFunction(
      () => (window as any).preparations.length === 3,
    );
    await viewer.evaluate(() => (window as any).browser.destroy());
    assert.equal(
      await viewer.evaluate(
        () => (window as any).preparations[2].signal.aborted,
      ),
      true,
    );
    await viewer.evaluate(() => (window as any).preparations[2].resolve(true));
    assert.equal(await viewer.locator('.floe-browser').count(), 0);
  },
);
