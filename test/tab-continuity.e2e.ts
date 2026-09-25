import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { PlaywrightSourceBrowser } from '../dist/host/playwright-source.js';
import { createProjectionServer } from '../dist/host/server.js';

for (const engine of [chromium, firefox, webkit])
  for (const observe of [false, true]) {
    test(
      `${engine.name()} ${observe ? 'observer' : 'controller'}: cold, warm and evicted tabs never blank the painted viewport`,
      { timeout: 40000 },
      async (t) => {
        const sourceBrowser = await chromium.launch();
        const context = await sourceBrowser.newContext();
        await context.route('https://continuity.test/**', (route) => {
          const name = new URL(route.request().url()).pathname.slice(1);
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><title>${name}</title><style>body{margin:0;background:#185f8e;color:white}button{height:100px;width:200px}</style><h1>${name}</h1><button onclick="this.textContent='Clicked'">${name}</button>`,
          });
        });
        const sources = [];
        for (let i = 0; i < 5; i++) {
          const source = await context.newPage();
          await source.goto(`https://continuity.test/page-${i}`);
          sources.push(source);
        }
        const owner = new PlaywrightSourceBrowser();
        const entries = await Promise.all(
          sources.map(async (source) => ({
            page: await owner.adopt(source),
            title: await source.title(),
          })),
        );
        const listeners = new Set<() => void>();
        for (const entry of entries)
          entry.page.on('titlechanged', (title) => {
            entry.title = title;
            for (const notify of listeners) notify();
          });
        const unavailable = async () => {
          throw new Error('No directory mutation in this fixture');
        };
        const directory = {
          list: () => entries,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          create: unavailable,
          close: unavailable,
          pin: unavailable,
          move: unavailable,
          restore: unavailable,
        };
        const service = await createProjectionServer(directory, {
          authorize: () => true,
        });
        if (observe)
          service.session.connect = (send, options) =>
            service.session.observe(send, options);
        const browser = await engine.launch();
        t.after(async () => {
          await service.close();
          await browser.close();
          await owner.dispose();
          await sourceBrowser.close();
        });
        const viewer = await browser.newPage();
        viewer.setDefaultTimeout(5000);
        await viewer.addInitScript(() => {
          (window as any).__name = (fn: unknown) => fn;
          const Native = WebSocket;
          (window as any).WebSocket = class extends Native {
            send(data: Parameters<WebSocket['send']>[0]) {
              if (
                typeof data === 'string' &&
                JSON.parse(data).action?.kind === 'tab_select'
              ) {
                setTimeout(() => super.send(data), 120);
              } else super.send(data);
            }
          };
        });
        await viewer.goto(service.url);
        await viewer.locator('#status.live').waitFor();
        const ids = await viewer
          .getByRole('tab')
          .evaluateAll((tabs) =>
            Object.fromEntries(
              tabs.map((tab) => [
                tab.textContent,
                (tab as HTMLElement).dataset.tab,
              ]),
            ),
          );
        assert.equal(Object.keys(ids).length, 5);
        await viewer.evaluate(() => {
          (window as any).paintedFrames = [];
          const sample = () => {
            const painted = [
              ...document.querySelectorAll<HTMLIFrameElement>(
                '#viewport iframe',
              ),
            ].some((frame) => {
              const root = frame.contentDocument?.documentElement;
              return (
                frame.checkVisibility({
                  checkOpacity: true,
                  checkVisibilityCSS: true,
                }) &&
                root?.checkVisibility({
                  checkOpacity: true,
                  checkVisibilityCSS: true,
                }) &&
                frame.contentDocument?.querySelector('h1')?.textContent
              );
            });
            (window as any).paintedFrames.push(Boolean(painted));
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
          await viewer.waitForFunction((name) => {
            const stage = document.querySelector('#viewport')?.parentElement;
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
            return (
              !stage?.classList.contains('switching') &&
              document.querySelector('#status.live') &&
              frame?.contentDocument?.querySelector('h1')?.textContent === name
            );
          }, name);
        }
        // A title update changes chrome, not the validity of a rendered document.
        await sources[0]!.evaluate(() => {
          document.title = 'Renamed';
        });
        await viewer
          .getByRole('tab', { name: 'Renamed', exact: true })
          .waitFor();
        await viewer.getByRole('tab', { name: 'Renamed', exact: true }).click();
        await viewer.locator('#status.live').waitFor();
        await viewer.waitForFunction(
          () =>
            !document
              .querySelector('#viewport')
              ?.parentElement?.classList.contains('switching'),
        );
        const frames = await viewer.evaluate(() => {
          cancelAnimationFrame((window as any).sampling);
          return (window as any).paintedFrames as boolean[];
        });
        assert.ok(frames.length > 20);
        assert.equal(
          frames.filter((value) => !value).length,
          0,
          `Blank frames: ${frames.filter((value) => !value).length}/${frames.length}`,
        );
        if (!observe) {
          await viewer
            .frameLocator('#viewport iframe')
            .getByRole('button', { name: 'page-0' })
            .click();
          await sources[0]!.getByRole('button', { name: 'Clicked' }).waitFor();
        } else {
          assert.equal(
            await sources[0]!.getByRole('button').textContent(),
            'page-0',
          );
        }
      },
    );
  }
