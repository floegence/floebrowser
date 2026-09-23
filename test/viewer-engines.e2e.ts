import { clickProjected, hoverProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

async function fixture(
  t: TestContext,
  client: BrowserType,
  codec: 'vp8' | 'h264' = 'vp8',
) {
  const sourceBrowser = await chromium.launch({
    channel: 'chromium',
    chromiumSandbox: true,
  });
  let service: Awaited<ReturnType<typeof createProjectionServer>> | undefined;
  let viewerBrowser: Awaited<ReturnType<BrowserType['launch']>> | undefined;
  t.after(async () => {
    try {
      await service?.close();
    } finally {
      await Promise.all([viewerBrowser?.close(), sourceBrowser.close()]);
    }
  });
  const context = await sourceBrowser.newContext();
  const source = await context.newPage();
  source.setDefaultTimeout(6000);
  // Exercise both supported source-local RTP encodings, not just Chromium's
  // default preference. This fixture never changes the production negotiation.
  await source.addInitScript((codec) => {
    (window as any).__name = (value: unknown) => value;
    const peers: RTCPeerConnection[] = ((window as any).fixturePeers = []);
    const Native = RTCPeerConnection;
    (window as any).RTCPeerConnection = class extends Native {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        peers.push(this);
      }
      addTransceiver(
        track: MediaStreamTrack | string,
        options?: RTCRtpTransceiverInit,
      ) {
        const transceiver = super.addTransceiver(track, options);
        if ((typeof track === 'string' ? track : track.kind) === 'video') {
          transceiver.setCodecPreferences(
            RTCRtpSender.getCapabilities('video')!.codecs.filter(
              (c) => c.mimeType.toLowerCase() === `video/${codec}`,
            ),
          );
        }
        return transceiver;
      }
    };
  }, codec);
  service = await createProjectionServer(source, { authorize: () => true });
  viewerBrowser = await client.launch();
  const sourceHTML = `<!doctype html><title>Cross-engine source</title><style>body{margin:20px;font:16px sans-serif}#layout{width:calc(100vw - 40px);height:40px;background:rgb(30,80,130)}</style><div id=layout></div><input aria-label="Source input"><button id=count onclick="this.textContent=String(++window.count)">Count</button><button id=play onclick="start()">Start media</button><video width=160 height=90 muted></video><canvas id=graphic width=120 height=60></canvas><output></output><script>
  window.count=0;window.sourceRuns=1;
  const graphic=document.querySelector('#graphic');
  graphic.getContext('2d').fillStyle='lime';graphic.getContext('2d').fillRect(0,0,120,60);
  async function start(){
    const canvas=window.fixtureCanvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
    const ctx=canvas.getContext('2d');
    setInterval(()=>{ctx.fillStyle='lime';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='black';ctx.fillText(String(Date.now()),80,80)},40);
    const audio=new AudioContext();await audio.resume();
    const oscillator=audio.createOscillator(),gain=audio.createGain(),destination=audio.createMediaStreamDestination();gain.gain.value=0;oscillator.connect(gain).connect(destination);oscillator.start();
    const stream=canvas.captureStream(25);stream.addTrack(destination.stream.getAudioTracks()[0]);
    const video=document.querySelector('video');video.srcObject=stream;await video.play();
  }
  </script>`;
  await context.route('http://engine.test/', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: sourceHTML,
    }),
  );
  await source.goto('http://engine.test/');
  const viewer = await viewerBrowser.newPage({
    viewport: { width: 1000, height: 750 },
  });
  viewer.setDefaultTimeout(6000);
  const failures: string[] = [],
    external: string[] = [];
  viewer.on('pageerror', (error) => failures.push(error.message));
  await viewer.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === new URL(service!.url).origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await viewer.addInitScript(() => {
    (window as any).decoded = {};
    (window as any).codecs = {};
    const Native = Worker;
    (window as any).Worker = class extends Native {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          (window as any).decoded[data.type] =
            ((window as any).decoded[data.type] ?? 0) + 1;
        });
      }
      postMessage(data: any, transfer: Transferable[]) {
        if (data.type === 'frame')
          (window as any).codecs[data.frame.header.codec] = true;
        super.postMessage(data, transfer);
      }
    };
    (window as any).RTCPeerConnection = class {
      constructor() {
        throw new Error('Client RTC is forbidden');
      }
    };
    const NativeSocket = WebSocket;
    (window as any).WebSocket = class extends NativeSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        if (String(args[0]).includes('/stream'))
          (window as any).controlSocket = this;
      }
    };
  });
  await viewer.goto(service.url);
  await viewer.locator('#status.live').waitFor();
  const content = viewer.frameLocator('#viewport iframe');
  t.diagnostic(`${client.name()} ${viewerBrowser.version()}`);
  return { source, viewer, content, external, failures };
}

for (const client of [chromium, firefox, webkit]) {
  test(
    `the ${client.name()} viewer forwards input through a scriptless projection`,
    {
      timeout: 20000,
    },
    async (t) => {
      const { source, viewer, content, external, failures } = await fixture(
        t,
        client,
      );
      await clickProjected(
        content.getByRole('button', { name: 'Count', exact: true }),
      );
      await source.waitForFunction(() => (window as any).count === 1);
      await clickProjected(
        content.getByRole('textbox', { name: 'Source input', exact: true }),
      );
      await viewer.keyboard.insertText('Source-only text 世界');
      await source.waitForFunction(
        () =>
          document.querySelector('input')!.value === 'Source-only text 世界',
      );
      await source.waitForFunction(
        () => document.querySelector('input')!.selectionStart === 19,
      );
      await viewer.keyboard.press('ArrowLeft');
      await viewer.keyboard.press('ArrowLeft');
      await viewer.keyboard.type('X');
      await source.waitForFunction(
        () =>
          document.querySelector('input')!.value === 'Source-only text X世界',
      );
      await viewer.waitForFunction(() => {
        const input =
          document.querySelector<HTMLInputElement>('.floe-input-proxy');
        return (
          input?.value === 'Source-only text X世界' &&
          input.selectionStart === 18 &&
          document.activeElement === input
        );
      });
      await source.evaluate(() => {
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Source choice');
        select.innerHTML =
          '<option value="first">First</option><optgroup label="Other"><option value="second">Second</option></optgroup>';
        document.body.append(select);
        const shadow = document.createElement('div');
        shadow.id = 'shadow';
        shadow.attachShadow({ mode: 'open' }).innerHTML =
          '<button onclick="window.count++">Shadow action</button>';
        document.body.append(shadow);
        const child = document.createElement('iframe');
        child.srcdoc =
          '<!doctype html><button onclick="this.textContent=event.isTrusted ? \'Trusted child action\' : \'Untrusted\'">Child action</button><input aria-label="Child input"><div style="height:3000px">Child scrolling</div>';
        child.style.cssText =
          'width:400px;height:180px;border:8px solid black;transform:scale(.85);transform-origin:top left';
        document.body.append(child);
      });
      await hoverProjected(content.getByRole('combobox'));
      await viewer.locator('select.floe-input-proxy').selectOption('second');
      await source.waitForFunction(
        () => document.querySelector('select')!.value === 'second',
      );
      await clickProjected(content.locator('#shadow button'));
      await source.waitForFunction(() => (window as any).count === 2);
      const child = content.frameLocator('iframe');

      await clickProjected(
        child.getByRole('button', { name: 'Child action', exact: true }),
      );
      await child
        .getByRole('button', { name: 'Trusted child action', exact: true })
        .waitFor();
      await clickProjected(
        child.getByRole('textbox', { name: 'Child input', exact: true }),
      );
      await viewer.keyboard.insertText('Nested 世界');
      await source
        .frames()
        .find((frame) => frame.parentFrame())!
        .waitForFunction(
          () => document.querySelector('input')!.value === 'Nested 世界',
        );
      await hoverProjected(child.locator('input'));
      await viewer.mouse.wheel(0, 240);
      await source
        .frames()
        .find((frame) => frame.parentFrame())!
        .waitForFunction(() => scrollY > 0);
      assert.equal(
        await viewer.locator('#viewport iframe').getAttribute('sandbox'),
        'allow-same-origin',
      );
      assert.deepEqual(external, []);
      assert.deepEqual(failures, []);
    },
  );

  for (const codec of ['vp8', 'h264'] as const)
    test(
      `the ${client.name()} viewer renders inert DOM and decodes host-carried ${codec} video, audio and Canvas`,
      {
        timeout: 30000,
      },
      async (t) => {
        const { source, viewer, content, external, failures } = await fixture(
          t,
          client,
          codec,
        );
        assert.equal(
          await content
            .locator('#layout')
            .evaluate((node) => getComputedStyle(node).backgroundColor),
          'rgb(30, 80, 130)',
        );
        assert.equal(
          await content
            .locator('body')
            .evaluate(() => (window as any).sourceRuns),
          undefined,
          'Website scripts never execute in the client',
        );
        await viewer.setViewportSize({ width: 1100, height: 780 });
        await source.waitForFunction(() => innerWidth === 1100);
        await viewer.waitForFunction(
          () =>
            Math.abs(
              (document
                .querySelector<HTMLIFrameElement>('#viewport iframe')
                ?.contentDocument?.querySelector('#layout')
                ?.getBoundingClientRect().width ?? 0) - 1060,
            ) < 2,
        );
        await viewer.waitForFunction(() =>
          document
            .querySelector<HTMLIFrameElement>('#viewport iframe')
            ?.contentDocument?.querySelector<HTMLImageElement>('#graphic')
            ?.src.startsWith('blob:'),
        );
        // A source user or AI may start playback while this client only watches.
        await source
          .getByRole('button', { name: 'Start media', exact: true })
          .click();
        try {
          await viewer.waitForFunction(() => {
            const v = document
              .querySelector<HTMLIFrameElement>('#viewport iframe')
              ?.contentDocument?.querySelector('video');
            return (
              !!v &&
              v.videoWidth === 160 &&
              v.readyState >= 2 &&
              (window as any).decoded.audio > 3 &&
              (window as any).decoded.video > 3
            );
          });
        } catch (error) {
          t.diagnostic(
            JSON.stringify({
              failures,
              decoded: await viewer.evaluate(() => (window as any).decoded),
              source: await source.evaluate(async () => {
                const video = document.querySelector('video')!;
                const peers: RTCPeerConnection[] = (window as any).fixturePeers;
                return {
                  readyState: video.readyState,
                  paused: video.paused,
                  dimensions: [video.videoWidth, video.videoHeight],
                  pictures: video.getVideoPlaybackQuality().totalVideoFrames,
                  tracks: (video.srcObject as MediaStream)
                    ?.getTracks()
                    .map((track) => ({
                      kind: track.kind,
                      state: track.readyState,
                      settings: track.getSettings(),
                    })),
                  peers: await Promise.all(
                    peers.map(async (peer) => ({
                      connection: peer.connectionState,
                      senders: peer
                        .getSenders()
                        .map((sender) => ({
                          kind: sender.track?.kind,
                          state: sender.track?.readyState,
                          settings: sender.track?.getSettings(),
                        })),
                      outbound: [...(await peer.getStats()).values()].filter(
                        (stat) => stat.type === 'outbound-rtp',
                      ),
                    })),
                  ),
                };
              }),
            }),
          );
          throw error;
        }
        assert.equal(
          await content.locator('video').evaluate((video: HTMLVideoElement) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(video, 0, 0, 1, 1);
            const pixel = ctx.getImageData(0, 0, 1, 1).data;
            return pixel[1]! > 180 && pixel[0]! < 80 && pixel[2]! < 80;
          }),
          true,
          'The client presents decoded source pixels',
        );
        assert.deepEqual(
          await viewer.evaluate(() =>
            Object.keys((window as any).codecs).sort(),
          ),
          [codec, 'opus'].sort(),
        );
        await source.evaluate(() => {
          const canvas = (window as any).fixtureCanvas as HTMLCanvasElement;
          canvas.width = 240;
          canvas.height = 136;
          // Resizing clears a canvas. Fill the new frame in the same task so a
          // source capture cannot legitimately pause on that transparent reset.
          const context = canvas.getContext('2d')!;
          context.fillStyle = 'lime';
          context.fillRect(0, 0, canvas.width, canvas.height);
        });
        await viewer.waitForFunction(() => {
          const video = document
            .querySelector<HTMLIFrameElement>('#viewport iframe')
            ?.contentDocument?.querySelector('video');
          return video?.videoWidth === 240 && video.videoHeight === 136;
        });
        await source.locator('video').evaluate((video) => video.pause());
        await viewer.evaluate(() => {
          (window as any).priorProjection =
            document.querySelector('#viewport iframe');
          (window as any).controlSocket.send(
            JSON.stringify({ type: 'resync' }),
          );
        });
        await viewer.waitForFunction(
          () =>
            document.querySelector('#viewport iframe') !==
            (window as any).priorProjection,
        );
        await viewer.waitForFunction(() => {
          const video = document
            .querySelector<HTMLIFrameElement>('#viewport iframe')
            ?.contentDocument?.querySelector('video');
          return video?.videoWidth === 240 && video.readyState >= 2;
        });
        assert.equal(
          await content.locator('video').evaluate((video: HTMLVideoElement) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(video, 0, 0, 1, 1);
            return ctx.getImageData(0, 0, 1, 1).data[1]! > 180;
          }),
          true,
          'A DOM checkpoint keeps the decoded paused picture after a source size change',
        );
        assert.deepEqual(external, []);
        assert.deepEqual(failures, []);
      },
    );
}
