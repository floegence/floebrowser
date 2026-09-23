import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

for (const context of ['2d', 'webgl2'] as const)
  test(
    `projects ${context} pixels and forwards trusted drag, wheel and keys`,
    { timeout: 25000 },
    async (t) => {
      const browser = await chromium.launch({ channel: 'chromium' });
      const clientBrowser = await chromium.launch({ channel: 'chromium' });
      const sourceContext = await browser.newContext();
      const source = await sourceContext.newPage();
      source.setDefaultTimeout(5000);
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(async () => {
        await clientBrowser.close();
        await browser.close();
        await service.close();
      });
      await source.goto(
        'data:text/html,<title>Canvas fixture</title><canvas id="scene" width="320" height="180" tabindex="0"></canvas><output id="effect"></output>',
      );
      await source.evaluate((type) => {
        const canvas = document.querySelector('canvas')!;
        const ctx = canvas.getContext(type)!;
        (window as any).draw = () => {
          if (type === '2d') {
            const c = ctx as CanvasRenderingContext2D;
            c.fillStyle = 'rgb(220,40,20)';
            c.fillRect(0, 0, 320, 180);
          } else {
            const gl = ctx as WebGL2RenderingContext;
            gl.clearColor(220 / 255, 40 / 255, 20 / 255, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
        };
        (window as any).draw();
        (window as any).effects = { down: 0, drag: 0, up: 0, wheel: 0, key: 0 };
        for (const name of [
          'pointerdown',
          'pointermove',
          'pointerup',
          'wheel',
          'keydown',
        ])
          canvas.addEventListener(name, (event) => {
            if (!event.isTrusted) return;
            const effects = (window as any).effects;
            if (event.type === 'pointerdown') {
              effects.down++;
              canvas.focus();
              canvas.setPointerCapture((event as PointerEvent).pointerId);
            }
            if (event.type === 'pointermove' && (event as PointerEvent).buttons)
              effects.drag++;
            if (event.type === 'pointerup') effects.up++;
            if (event.type === 'wheel') {
              event.preventDefault();
              effects.wheel++;
            }
            if (event.type === 'keydown') effects.key++;
          });
      }, context);
      const viewer = await clientBrowser.newPage();
      viewer.setDefaultTimeout(5000);
      const failures: unknown[] = [];
      const commands = new Map<number, unknown>();
      await viewer.addInitScript(() => {
        const Socket = WebSocket;
        (window as any).WebSocket = class extends Socket {
          constructor(...args: ConstructorParameters<typeof WebSocket>) {
            super(...args);
            if (String(args[0]).includes('/stream'))
              (window as any).testSocket = this;
          }
        };
        const Peer = RTCPeerConnection;
        (window as any).peers = [];
        (window as any).RTCPeerConnection = class extends Peer {
          constructor(config?: RTCConfiguration) {
            super(config);
            (window as any).peers.push(this);
          }
        };
      });
      viewer.on('websocket', (socket) => {
        socket.on('framesent', ({ payload }) => {
          if (typeof payload !== 'string') return;
          const message = JSON.parse(payload);
          if (message.type === 'command') commands.set(message.id, message);
        });
        socket.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string') return;
          const m = JSON.parse(String(payload));
          if (m.type === 'ack' && !m.ok)
            failures.push({ ...m, command: commands.get(m.id) });
        });
      });
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor({ timeout: 5000 });
      const pixels = () =>
        viewer.waitForFunction(
          () => {
            const v = document
              .querySelector<HTMLIFrameElement>('#viewport iframe')
              ?.contentDocument?.querySelector<HTMLImageElement>('#scene');
            if (
              v?.tagName !== 'IMG' ||
              !v.complete ||
              !v.naturalWidth ||
              !v.src.startsWith('blob:')
            )
              return false;
            const c = document.createElement('canvas');
            c.width = 1;
            c.height = 1;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(v, 0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return r! > 180 && g! < 80 && b! < 60;
          },
          null,
          { timeout: 5000 },
        );
      await pixels();
      const scene = viewer.frameLocator('#viewport iframe').locator('#scene');
      const rect = (await scene.boundingBox({ timeout: 2000 }))!;
      await viewer.mouse.move(rect.x + 40, rect.y + 40);
      await viewer.mouse.down();
      // Dispatch the drag directly; Playwright's native drag interception can
      // wait indefinitely when a remote page also captures the pointer.
      const input = await viewer.context().newCDPSession(viewer);
      await input.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: rect.x + 140,
        y: rect.y + 80,
        button: 'left',
        buttons: 1,
      });
      await viewer.mouse.up();
      await viewer.mouse.wheel(0, 100);
      await viewer.keyboard.press('ArrowRight');
      await viewer.keyboard.press('w');
      await source
        .waitForFunction(
          () => {
            const e = (window as any).effects;
            return (
              e.down === 1 &&
              e.drag > 0 &&
              e.up === 1 &&
              e.wheel > 0 &&
              e.key === 2
            );
          },
          null,
          { timeout: 4000 },
        )
        .catch(async (error) => {
          t.diagnostic(
            JSON.stringify({
              effects: await source.evaluate(() => (window as any).effects),
              failures,
            }),
          );
          throw error;
        });
      assert.deepEqual(failures, []);
      await source.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'native-input';
        input.onkeydown = (event) => {
          if (event.key === 'x') event.preventDefault();
          if (event.key === '.')
            (window as any).punctuationCode = event.keyCode;
        };
        document.body.append(input);
      });
      await clickProjected(
        viewer.frameLocator('#viewport iframe').locator('#native-input'),
      );
      await viewer.keyboard.type('ax.b');
      await source.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>('#native-input')?.value ===
          'a.b',
      );
      assert.equal(
        await source.evaluate(() => (window as any).punctuationCode),
        190,
      );
      assert.equal(
        await viewer.locator('.floe-media-controls').isVisible(),
        false,
        'Canvas has no playback/seek controls',
      );
      assert.equal(
        await viewer.locator('#viewport iframe').getAttribute('sandbox'),
        'allow-same-origin',
      );
      await viewer.evaluate(() => {
        (window as any).beforeCheckpoint = document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector('#scene');
      });
      await viewer.evaluate(() =>
        (window as any).testSocket.send(JSON.stringify({ type: 'resync' })),
      );
      await viewer.waitForFunction(() => {
        const image = document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector<HTMLImageElement>('#scene');
        return (
          image !== (window as any).beforeCheckpoint &&
          image?.src.startsWith('blob:')
        );
      });
      await pixels();
      await viewer
        .getByRole('button', { name: 'New tab', exact: true })
        .click();
      // The viewer never creates WebRTC peers. Wait for the new source tab,
      // rather than a vacuously true empty peer list, before switching back.
      await viewer.waitForFunction(
        () =>
          document.querySelector('[role="tab"][aria-selected="true"]')
            ?.textContent === 'New tab' &&
          document
            .querySelector('#viewport')
            ?.parentElement?.classList.contains('switching') === false,
      );
      await viewer
        .waitForFunction(() =>
          (window as any).peers.every(
            (peer: RTCPeerConnection) => peer.connectionState === 'closed',
          ),
        )
        .catch(async (error) => {
          t.diagnostic(
            JSON.stringify({
              tabs: await viewer.locator('[role="tab"]').allTextContents(),
              failures,
              peers: await viewer.evaluate(() =>
                (window as any).peers.map(
                  (p: RTCPeerConnection) => p.connectionState,
                ),
              ),
            }),
          );
          throw error;
        });
      await viewer
        .getByRole('tab', { name: 'Canvas fixture', exact: true })
        .click();
      await viewer.waitForFunction(() => {
        const viewport = document.querySelector('#viewport');
        return (
          viewport?.parentElement?.classList.contains('switching') === false &&
          document.querySelector('[role="tab"][aria-selected="true"]')
            ?.textContent === 'Canvas fixture'
        );
      });
      await pixels();
      await viewer.reload();
      await pixels();
      // No source redraw occurs during these transitions: the latest source
      // bitmap, not a cleared WebGL drawing buffer, seeds every new controller.
      await source.evaluate(() => {
        (window as any).removed = document.querySelector('canvas');
        (window as any).removed.remove();
      });
      await viewer
        .frameLocator('#viewport iframe')
        .locator('#scene')
        .waitFor({ state: 'detached' });
      await viewer.waitForFunction(() =>
        (window as any).peers.every(
          (peer: RTCPeerConnection) => peer.connectionState === 'closed',
        ),
      );
      await source.evaluate(() => {
        document.body.append((window as any).removed);
        (window as any).draw();
      });
      await pixels();
      if (context === '2d') {
        await source.evaluate(() => {
          const canvas = document.querySelector('canvas')!;
          canvas.width = 2600;
          canvas.height = 1300;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = 'rgba(220,40,20,0.5)';
          ctx.fillRect(0, 0, 1300, 1300);
        });
        await viewer
          .waitForFunction(() => {
            const image = document
              .querySelector<HTMLIFrameElement>('#viewport iframe')
              ?.contentDocument?.querySelector<HTMLImageElement>('#scene');
            if (
              !image?.complete ||
              image.naturalWidth !== 2600 ||
              !image.src.startsWith('blob:')
            )
              return false;
            const canvas = document.createElement('canvas');
            canvas.width = 2;
            canvas.height = 1;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 300, 300, 1, 1, 0, 0, 1, 1);
            ctx.drawImage(image, 2000, 300, 1, 1, 1, 0, 1, 1);
            const rgba = ctx.getImageData(0, 0, 2, 1).data;
            (window as any).canvasDiagnostic = {
              rgba: [...rgba],
              width: image.naturalWidth,
              size: image.getAttribute('data-floebrowser-canvas'),
            };
            return rgba[3]! > 110 && rgba[3]! < 145 && rgba[7] === 0;
          })
          .catch(async (error) => {
            t.diagnostic(
              JSON.stringify(
                await viewer.evaluate(() => (window as any).canvasDiagnostic),
              ),
            );
            throw error;
          });
        assert.equal(
          await scene.evaluate(
            (element) => element.getBoundingClientRect().width,
          ),
          2600,
          'Compressed frames must preserve the source intrinsic layout',
        );
      }
      await viewer.close();
      assert.deepEqual(failures, []);
    },
  );

test(
  'cross-origin WebGL redraws remain scriptless, with explicit tainted and offscreen failures',
  { timeout: 25000 },
  async (t) => {
    const { createServer } = await import('node:http');
    let port = 0;
    const site = createServer((req, res) => {
      if (req.url === '/image.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
        );
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        req.url === '/'
          ? `<!doctype html><title>Canvas frames</title>
      <iframe id="remote" src="http://localhost:${port}/frame" width="340" height="200"></iframe>
      <canvas id="tainted" width="180" height="100"></canvas><canvas id="offscreen" width="180" height="100"></canvas>
      <script>
        window.siteExecuted=true;
        const image=new Image();image.onload=()=>tainted.getContext('2d').drawImage(image,0,0);image.src='http://localhost:${port}/image.svg';
        offscreen.transferControlToOffscreen().getContext('2d').fillRect(0,0,100,100);
      </script>`
          : `<!doctype html><canvas id="gl" width="320" height="180"></canvas><button onclick="this.textContent='Source confirmed'">Source click</button><script>
        window.siteExecuted=true;const gl=document.querySelector('canvas').getContext('webgl2');gl.clearColor(0,0.8,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
      </script>`,
      );
    });
    await new Promise<void>((r) => site.listen(0, r));
    port = (site.address() as { port: number }).port;
    const browser = await chromium.launch({ channel: 'chromium' });
    const context = await browser.newContext();
    const source = await context.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(5000);
    const external: string[] = [];
    await viewer.route('**/*', (route) => {
      if (
        new URL(route.request().url()).origin !== new URL(service.url).origin
      ) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    t.after(async () => {
      await browser.close();
      await service.close();
      await new Promise<void>((r) => site.close(() => r()));
    });
    await source.goto(`http://127.0.0.1:${port}/`);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const child = source
      .frames()
      .find((frame) => frame.url().endsWith('/frame'))!;
    // Chromium OOPIF attachment can follow its first inline render. Qualify a
    // new source render after attachment; a discarded pre-attachment WebGL
    // buffer cannot be recovered without asking the site to render again.
    await child.waitForFunction(() =>
      Object.getOwnPropertyNames(window).some((key) => key.endsWith(':canvas')),
    );
    await child.evaluate(() => {
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      gl.clearColor(0, 0.8, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
    await viewer
      .waitForFunction(() => {
        const root =
          document.querySelector<HTMLIFrameElement>(
            '#viewport iframe',
          )?.contentDocument;
        const img = root
          ?.querySelector<HTMLIFrameElement>('#remote')
          ?.contentDocument?.querySelector<HTMLImageElement>('#gl');
        if (!img?.complete || !img.src.startsWith('blob:')) return false;
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[1]! > 150;
      })
      .catch(async (error) => {
        t.diagnostic(
          JSON.stringify(
            await viewer.evaluate(() => {
              const doc = document
                .querySelector<HTMLIFrameElement>('#viewport iframe')
                ?.contentDocument?.querySelector<HTMLIFrameElement>(
                  '#remote',
                )?.contentDocument;
              return {
                images: [...(doc?.querySelectorAll('img') ?? [])].map((i) => ({
                  src: i.src.slice(0, 70),
                  size: i.getAttribute('data-floebrowser-canvas'),
                  w: i.naturalWidth,
                })),
              };
            }),
          ),
        );
        t.diagnostic(
          JSON.stringify(
            await source.frames()[1]!.evaluate(() => {
              const key = Object.getOwnPropertyNames(window).find((k) =>
                k.endsWith(':canvas'),
              )!;
              const canvas = document.querySelector('canvas')!;
              const surface = (window as any)[key]?.get(canvas);
              return {
                revision: surface?.revision,
                error: surface?.error,
                pixel: surface
                  ? [
                      ...surface.bitmap
                        .getContext('2d')
                        .getImageData(5, 5, 1, 1).data,
                    ]
                  : null,
              };
            }),
          ),
        );
        throw error;
      });
    const root = viewer.frameLocator('#viewport iframe');
    await root.locator('#tainted[data-floebrowser-unsupported]').waitFor();
    await root.locator('#offscreen[data-floebrowser-unsupported]').waitFor();
    await clickProjected(
      root
        .frameLocator('#remote')
        .getByRole('button', { name: 'Source click' }),
    );
    await root
      .frameLocator('#remote')
      .getByRole('button', { name: 'Source confirmed' })
      .waitFor();
    assert.equal(
      await viewer.evaluate(
        () =>
          !!(
            document.querySelector<HTMLIFrameElement>('#viewport iframe')
              ?.contentWindow as any
          )?.siteExecuted,
      ),
      false,
    );
    assert.deepEqual(external, []);
  },
);

test(
  'slow canvas encoding keeps one pending image while source input and the newest scene continue',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch({ channel: 'chromium' });
    const context = await browser.newContext();
    const source = await context.newPage();
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await browser.close();
      await service.close();
    });
    await source.goto(
      'data:text/html,<canvas width="320" height="180"></canvas><button onclick="window.color=\'blue\';this.textContent=\'Confirmed\'">Change scene</button>',
    );
    await source.evaluate(() => {
      (window as any).color = 'red';
      (window as any).encodes = 0;
      const encode = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = function (options) {
        (window as any).encodes++;
        const result = encode.call(this, options);
        if ((window as any).encodes === 1)
          return new Promise((resolve) => {
            (window as any).releaseFrame = () => resolve(result);
          });
        return result;
      };
      const canvas = document.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      setInterval(() => {
        ctx.fillStyle = (window as any).color;
        ctx.fillRect(0, 0, 320, 180);
      }, 16);
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(5000);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await source.waitForFunction(() => (window as any).encodes === 1);
    await clickProjected(
      viewer
        .frameLocator('#viewport iframe')
        .getByRole('button', { name: 'Change scene' }),
    );
    await source.waitForFunction(
      () => document.querySelector('button')?.textContent === 'Confirmed',
    );
    assert.equal(
      await source.evaluate(() => (window as any).encodes),
      1,
      'Input must not wait behind encoding, and encoding must not accumulate',
    );
    await source.evaluate(() => (window as any).releaseFrame());
    await viewer.waitForFunction(() => {
      const image = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector<HTMLImageElement>(
          '[data-floebrowser-canvas]',
        );
      if (!image?.complete || !image.src.startsWith('blob:')) return false;
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(image, 0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[2]! > 180;
    });
  },
);

test(
  'Canvas retransmissions reuse the decoded resource while changed pixels and dimensions still update',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({ channel: 'chromium' });
    const source = await browser.newPage();
    await source.goto(
      'data:text/html,<canvas id="scene" width="160" height="90" tabindex="0"></canvas>',
    );
    await source.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      (window as any).color = 'lime';
      setInterval(() => {
        const context = canvas.getContext('2d')!;
        context.fillStyle = (window as any).color;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 40);
    });
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    const viewer = await browser.newPage();
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    await viewer.goto(service.url);
    const displayedColor = ({
      channel,
      width,
    }: {
      channel: number;
      width: number;
    }) => {
      const image = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentDocument?.querySelector<HTMLImageElement>('#scene');
      if (!image?.complete || image.naturalWidth !== width) return false;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[channel]! > 180;
    };
    await viewer.waitForFunction(displayedColor, { channel: 1, width: 160 });
    const resources = await viewer.evaluate(async () => {
      const image = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')!
        .contentDocument!.querySelector<HTMLImageElement>('#scene')!;
      const before = image.src;
      let changes = 0;
      const observer = new MutationObserver((records) => {
        changes += records.filter(
          (record) => record.attributeName === 'src',
        ).length;
      });
      observer.observe(image, { attributes: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      observer.disconnect();
      return { before, after: image.src, changes };
    });
    assert.equal(
      resources.changes,
      0,
      'Retransmitting identical pixels must not allocate and decode another image',
    );
    assert.equal(resources.after, resources.before);
    await viewer.evaluate(() => {
      const image = document
        .querySelector<HTMLIFrameElement>('#viewport iframe')!
        .contentDocument!.querySelector<HTMLImageElement>('#scene')!;
      (window as any).canvasMutations = [];
      const observer = new MutationObserver((records) => {
        for (const record of records)
          if (
            ['src', 'data-floebrowser-canvas'].includes(record.attributeName!)
          )
            (window as any).canvasMutations.push(record.attributeName);
      });
      observer.observe(image, { attributes: true });
      (window as any).canvasObserver = observer;
    });
    const scene = viewer.frameLocator('#viewport iframe').locator('#scene');
    await scene.click();
    await viewer.keyboard.press('ArrowRight');
    await viewer.mouse.move(900, 500);
    await source.waitForFunction(() => document.activeElement?.id === 'scene');
    await viewer.waitForFunction(displayedColor, { channel: 1, width: 160 });
    assert.deepEqual(
      await viewer.evaluate(() => {
        (window as any).canvasObserver.disconnect();
        return (window as any).canvasMutations;
      }),
      [],
      'Hover, pointer and focus transitions preserve the current Canvas resource and dimensions',
    );
    await source.evaluate(() => {
      (window as any).color = 'blue';
    });
    await viewer.waitForFunction(displayedColor, { channel: 2, width: 160 });
    await source.evaluate(() => {
      document.querySelector('canvas')!.width = 320;
    });
    await viewer.waitForFunction(displayedColor, { channel: 2, width: 320 });
  },
);
