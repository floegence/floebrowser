import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

for (const engine of [chromium, firefox, webkit])
  test(
    `${engine.name()} presents a retained paused picture after hidden document preparation without new frames`,
    { timeout: 20000 },
    async (t) => {
      const browser = await engine.launch();
      t.after(() => browser.close());
      const page = await browser.newPage();
      page.setDefaultTimeout(4000);
      await page.route('http://127.0.0.1/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        await route.fulfill(
          path === '/'
            ? { contentType: 'text/html', body: '<div id="surface"></div>' }
            : {
                contentType: 'text/javascript',
                body: await readFile(new URL(`..${path}`, import.meta.url)),
              },
        );
      });
      await page.goto('http://127.0.0.1/');
      await page.evaluate(async () => {
        (window as any).__name = (value: unknown) => value;
        const { MediaView } = await import('/dist/viewer/media.js');
        const surface = document.querySelector<HTMLElement>('#surface')!;
        const replace = () => {
          const frame = document.createElement('iframe');
          frame.setAttribute('sandbox', 'allow-same-origin');
          surface.replaceChildren(frame);
          frame.contentDocument!.body.innerHTML =
            '<video width="160" height="90"></video>';
        };
        replace();
        const view = new MediaView(
          undefined,
          () =>
            document
              .querySelector('iframe')
              ?.contentDocument?.querySelector('video'),
          async () => {
            throw new Error('A paused picture cannot request source input');
          },
          () => {},
        );
        view.receive(
          {
            kind: 'state',
            id: 1,
            stream: 's',
            paused: true,
            muted: true,
            volume: 1,
            time: 0,
            duration: 1,
            status: 'streaming',
            reason: '',
          },
          { target: 't', view: 'v' },
        );
        const canvas = document.createElement('canvas');
        canvas.width = 240;
        canvas.height = 136;
        const context = canvas.getContext('2d')!;
        context.fillStyle = 'lime';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const playback = view.playback.get('t:s');
        view.decoded(playback, {
          type: 'video',
          frame: new VideoFrame(canvas, { timestamp: 0 }),
        });
        (window as any).fixture = { view, replace, surface, playback };
      });
      const picture = () => {
        const video = document
          .querySelector('iframe')
          ?.contentDocument?.querySelector('video');
        if (
          video?.videoWidth !== 240 ||
          video.videoHeight !== 136 ||
          video.readyState < 2
        )
          return false;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.drawImage(video, 0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return pixel[1]! > 220 && pixel[0]! < 10 && pixel[2]! < 10;
      };
      await page.waitForFunction(picture);
      for (let replacement = 0; replacement < 2; replacement++) {
        assert.equal(
          await page.evaluate(() => {
            const { view, replace, surface } = (window as any).fixture;
            surface.style.visibility = 'hidden';
            replace();
            view.update();
            return document
              .querySelector('iframe')!
              .contentDocument!.querySelector('video')!.srcObject;
          }),
          null,
          'Hidden preparation does not start a video consumer',
        );
        await page.evaluate(() => {
          const { view, surface } = (window as any).fixture;
          surface.style.visibility = '';
          view.update();
        });
        await page.waitForFunction(picture);
      }
      assert.equal(
        await page.evaluate(() => {
          const { view, playback } = (window as any).fixture;
          const tracks = playback.stream.getTracks();
          view.destroy();
          return tracks.every(
            (track: MediaStreamTrack) => track.readyState === 'ended',
          );
        }),
        true,
        'Teardown releases the retained local capture tracks',
      );
    },
  );
