import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Browser } from 'playwright';
import { CDPSourcePage } from '../dist/host/cdp-source.js';
import { createProjectionServer } from '../dist/host/server.js';

test(
  'an actual Chrome extension lends its one authorized debugger to DOM, child frames, files and element media',
  { timeout: 30000 },
  async (t) => {
    let stage = 'launch';
    const directory = await mkdtemp(join(tmpdir(), 'floebrowser-extension-'));
    let context: BrowserContext | undefined;
    let browser: Browser | undefined;
    let source: CDPSourcePage | undefined;
    let service: Awaited<ReturnType<typeof createProjectionServer>> | undefined;
    let pump: Promise<void> | undefined;
    let active = true;
    let port = 0;
    const site = createServer((request, response) => {
      if (request.url === '/theme.css') {
        response.setHeader('content-type', 'text/css');
        response.end('h1{color:rgb(24,72,128)}');
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url?.startsWith('/child')) {
        response.end(
          '<!doctype html><style>button{height:40px}</style><button onclick="this.textContent=\'Source action confirmed\'">Child action</button><input aria-label="Child input">',
        );
        return;
      }
      response.end(
        `<!doctype html><title>Extension source</title><link rel=stylesheet href="http://localhost:${port}/theme.css"><h1>Authorized source</h1><input id=upload type=file onchange="this.files[0].text().then(value=>document.querySelector('output').textContent=value)"><output></output><iframe src="http://localhost:${port}/child" style="width:400px;height:240px"></iframe><canvas id=canvas width=160 height=80></canvas><script>let n=0;setInterval(()=>{const c=canvas.getContext('2d');c.fillStyle=++n%2?'red':'blue';c.fillRect(0,0,160,80)},80)</script>`,
      );
    });
    const stateMessages: unknown[] = [];
    const failures: unknown[] = [];
    t.after(async () => {
      t.diagnostic(`Last extension qualification stage: ${stage}`);
      if (stage !== 'close')
        t.diagnostic(
          JSON.stringify({
            stateMessages,
            failures: failures.map(String),
            frames: source?.frames().map((frame) => ({
              id: frame.id,
              url: frame.url(),
              context: frame.contextID,
            })),
          }),
        );
      await service?.close();
      source?.dispose();
      active = false;
      await context?.close();
      await browser?.close();
      await pump;
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    port = (site.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const childURL = `http://localhost:${port}/child`;
    const extension = join(directory, 'extension');
    await mkdir(extension);
    await writeFile(
      join(extension, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'FloeBrowser source qualification',
        version: '1.0',
        permissions: ['debugger', 'tabs'],
        background: { service_worker: 'source.js' },
      }),
    );
    await writeFile(
      join(extension, 'source.js'),
      `
    let waiting; const events=[];
    globalThis.nextEvents=()=>events.length?events.splice(0):new Promise(resolve=>{waiting=resolve;});
    chrome.debugger.onEvent.addListener((source,method,params)=> {
      if(source.tabId!==globalThis.grantedTab) return;
      events.push({source,method,params});
      if(waiting) {const done=waiting;waiting=undefined;done(events.splice(0));}
    });
  `,
    );
    context = await chromium.launchPersistentContext(
      join(directory, 'profile'),
      {
        channel: 'chromium',
        chromiumSandbox: true,
        headless: true,
        args: [
          '--site-per-process',
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    stage = 'worker';
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const unrelated = await context.newPage();
    await unrelated.goto(
      'data:text/html,<title>Private unrelated tab</title><p>Private unrelated content</p>',
    );
    const sourcePage = await context.newPage();
    sourcePage.setDefaultTimeout(6000);
    stage = 'navigate';
    await sourcePage.goto(origin + '/');
    stage = 'grant';
    const tabId = await worker.evaluate(async (url) => {
      const api = (globalThis as any).chrome;
      const [tab] = await api.tabs.query({
        url,
      });
      (globalThis as any).grantedTab = tab.id;
      await api.debugger.attach({ tabId: tab.id }, '1.3');
      return tab.id as number;
    }, origin + '/');
    const calls: string[] = [];
    class ExtensionTransport extends EventEmitter {
      constructor(readonly session?: string) {
        super();
      }
      send(method: string, parameters: any = {}) {
        calls.push(method);
        return worker.evaluate(
          ({ tabId, session, method, parameters }) =>
            (globalThis as any).chrome.debugger.sendCommand(
              { tabId, ...(session ? { sessionId: session } : {}) },
              method,
              parameters,
            ),
          { tabId, session: this.session, method, parameters },
        );
      }
    }
    const root = new ExtensionTransport();
    const children = new Map<string, ExtensionTransport>();
    pump = (async () => {
      while (active) {
        const events = await worker.evaluate(() =>
          (globalThis as any).nextEvents(),
        );
        for (const { source: owner, method, params } of events) {
          if (
            method === 'Target.attachedToTarget' &&
            params.targetInfo.type === 'iframe'
          ) {
            const child = new ExtensionTransport(params.sessionId);
            children.set(params.sessionId, child);
            void source!
              .addSession(child)
              .then(() =>
                child.send('Target.setAutoAttach', {
                  autoAttach: true,
                  waitForDebuggerOnStart: true,
                  flatten: true,
                  filter: [
                    { type: 'iframe', exclude: false },
                    { exclude: true },
                  ],
                }),
              )
              .then(() => child.send('Runtime.runIfWaitingForDebugger'))
              .catch((error) => failures.push(error));
          } else if (method === 'Target.detachedFromTarget') {
            const child = children.get(params.sessionId);
            if (child) source!.removeSession(child);
            children.delete(params.sessionId);
          }
          (owner.sessionId ? children.get(owner.sessionId) : root)?.emit(
            method,
            params,
          );
        }
      }
    })().catch((error) => {
      if (active) failures.push(error);
    });
    stage = 'source adapter';
    source = await CDPSourcePage.attach({
      id: 'extension-authorized-page',
      transport: root,
      viewport: { width: 1280, height: 720 },
    });
    stage = 'child attachment';
    await root.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    });
    stage = 'projection';
    service = await createProjectionServer(source, {
      authorize: () => true,
    });
    browser = await chromium.launch();
    const viewer = await browser.newPage();
    viewer.on('pageerror', (error) =>
      stateMessages.push({ error: error.message }),
    );
    viewer.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return;
        const message = JSON.parse(payload);
        if (['state', 'notice', 'hello'].includes(message.type))
          stateMessages.push(message);
        else if (message.type === 'snapshot')
          stateMessages.push({ type: 'snapshot' });
      }),
    );
    viewer.setDefaultTimeout(6000);
    const external: string[] = [];
    await viewer.route('**/*', (route) => {
      if (
        new URL(route.request().url()).origin === new URL(service!.url).origin
      )
        return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await viewer.goto(service.url);
    stage = 'viewer';
    await viewer.locator('#status.live').waitFor();
    assert.equal(
      await viewer.getByRole('tab').count(),
      1,
      'Extension connection never grants unrelated existing tabs',
    );
    const projection = viewer.frameLocator('#viewport iframe');
    assert.equal(
      await projection.locator('h1').textContent(),
      'Authorized source',
    );
    assert.equal(
      await projection
        .locator('h1')
        .evaluate((node) => getComputedStyle(node).color),
      'rgb(24, 72, 128)',
    );
    const child = projection.frameLocator('iframe');
    stage = 'child input';
    await child
      .getByRole('button', { name: 'Child action', exact: true })
      .click();
    await child
      .getByRole('button', { name: 'Source action confirmed', exact: true })
      .waitFor();
    stage = 'child text';
    await child
      .getByRole('textbox', { name: 'Child input', exact: true })
      .click();
    await child
      .getByRole('textbox', { name: 'Child input', exact: true })
      .fill('Remote extension text');
    await sourcePage
      .frame({ url: childURL })!
      .waitForFunction(
        () =>
          document.querySelector('input')!.value === 'Remote extension text',
      );
    await projection.locator('#upload').click();
    stage = 'upload';
    const chooser = viewer.getByRole('dialog', {
      name: 'Choose files for this website',
      exact: true,
    });
    await chooser.locator('input[type=file]').setInputFiles({
      name: 'extension.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Authorized extension upload'),
    });
    await sourcePage.waitForFunction(
      () =>
        document.querySelector('output')!.textContent ===
        'Authorized extension upload',
    );
    stage = 'canvas';
    await viewer.waitForFunction(() =>
      document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector<HTMLImageElement>('#canvas')
        ?.src.startsWith('blob:'),
    );
    assert.ok(
      children.size > 0,
      'The extension owns the real out-of-process child session',
    );
    assert.deepEqual(
      external,
      [],
      'Projected content never directly contacts source sites',
    );
    stage = 'child replacement';
    await sourcePage
      .locator('iframe')
      .evaluate((node: HTMLIFrameElement, url) => {
        node.src = url;
      }, childURL + '/replacement');
    await child
      .getByRole('button', { name: 'Child action', exact: true })
      .click();
    await child
      .getByRole('button', { name: 'Source action confirmed', exact: true })
      .waitFor();
    stage = 'navigation';
    await sourcePage.goto(origin + '/next');
    await child
      .getByRole('button', { name: 'Child action', exact: true })
      .click();
    await child
      .getByRole('button', { name: 'Source action confirmed', exact: true })
      .waitFor();
    assert.equal(await viewer.getByRole('tab').count(), 1);
    stage = 'close';
    await service.close();
    assert.equal(
      (
        await root.send('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true,
        })
      ).result.value,
      'Extension source',
    );
    assert.equal(sourcePage.isClosed(), false);
    assert.ok(
      !calls.some((method) =>
        /^(Target\.(attachToTarget|detachFromTarget)|Runtime.disable|Network.disable)$/.test(
          method,
        ),
      ),
      'Projection teardown leaves debugger ownership with the host',
    );
    assert.deepEqual(failures, []);
  },
);
