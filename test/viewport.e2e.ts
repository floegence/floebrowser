import { clickProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { fixture } from './fixture.js';

async function dimensions(viewer: Page) {
  return viewer.locator('#viewport').evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }));
}

async function adapted(source: Page, viewer: Page) {
  const size = await dimensions(viewer);
  await source.waitForFunction(
    (size) => innerWidth === size.width && innerHeight === size.height,
    size,
    { timeout: 4000 },
  );
  await viewer.waitForFunction(
    (size) => {
      const frame =
        document.querySelector<HTMLIFrameElement>('#viewport iframe');
      const surface = document.querySelector('.floe-projection')!;
      const rect = surface.getBoundingClientRect();
      const container = document
        .querySelector('#viewport')!
        .getBoundingClientRect();
      return (
        frame?.contentWindow?.innerWidth === size.width &&
        frame.contentWindow.innerHeight === size.height &&
        Math.abs(rect.width - size.width) < 1 &&
        Math.abs(rect.height - size.height) < 1 &&
        Math.abs(rect.x - container.x) < 1 &&
        Math.abs(rect.y - container.y) < 1
      );
    },
    size,
    { timeout: 4000 },
  );
}

for (const allowed of [true, false])
  test(
    `initial presentation settles viewport authorization before accepting clicks: allowed=${allowed}`,
    { timeout: 15000 },
    async (t) => {
      const site = await fixture();
      const browser = await chromium.launch({ chromiumSandbox: true });
      const source = await browser.newPage();
      await source.goto(site.url);
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const service = await createProjectionServer(source, {
        authorize: async (action) => {
          if (action.kind !== 'viewport') return true;
          entered();
          await gate;
          return allowed;
        },
      });
      t.after(async () => {
        release();
        await browser.close();
        await service.close();
        await site.close();
      });
      const viewer = await browser.newPage({
        viewport: { width: 1100, height: 850 },
      });
      viewer.setDefaultTimeout(4000);
      await viewer.goto(service.url);
      await waiting;
      assert.equal(
        await viewer.locator('#status.live').count(),
        0,
        'A pending initial resize must not expose a view that will change scale under the first click',
      );
      assert.equal(await viewer.locator('#new-tab').isEnabled(), true);
      release();
      await viewer.locator('#status.live').waitFor();
      if (allowed) {
        const size = await dimensions(viewer);
        assert.deepEqual(source.viewportSize(), size);
        assert.deepEqual(
          await viewer
            .locator('#viewport iframe')
            .evaluate((frame: HTMLIFrameElement) => ({
              width: frame.contentWindow!.innerWidth,
              height: frame.contentWindow!.innerHeight,
            })),
          size,
        );
      }
      await clickProjected(
        viewer.frameLocator('#viewport iframe').locator('#count'),
      );
      await source.waitForFunction(
        () => document.querySelector('#count-value')?.textContent === '1',
        null,
        { timeout: 4000 },
      );
    },
  );

test(
  'the source and projection fill the client viewport and reflow without reloading or replacing media',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    let service: Awaited<ReturnType<typeof createProjectionServer>> | undefined;
    t.after(async () => {
      await service?.close();
      await browser.close();
    });
    const source = await browser.newPage();
    await source.goto(
      'data:text/html,' +
        encodeURIComponent(`<!doctype html>
      <style>body{margin:0;height:4000px}#layout{display:grid;grid-template-columns:1fr 1fr}#edge{position:fixed;right:8px;top:8px}@media(max-width:800px){#layout{grid-template-columns:1fr}}</style>
      <div id="layout"><span>First column</span><span>Second column</span></div>
      <video id="clip" width="160" height="90" muted></video>
      <button id="edge" onclick="this.textContent=++window.clicks">Click at the edge</button>
      <script>window.clicks=0;window.loads=1;const c=document.createElement('canvas');c.width=160;c.height=90;const x=c.getContext('2d');let n=0;setInterval(()=>{x.fillStyle=++n%2?'red':'blue';x.fillRect(0,0,160,90)},40);clip.srcObject=c.captureStream(25);clip.play();</script>`),
    );
    service = await createProjectionServer(source, { authorize: () => true });
    const viewer = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    viewer.setDefaultTimeout(4000);
    let snapshots = 0;
    const failures: unknown[] = [];
    viewer.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return;
        const message = JSON.parse(String(payload));
        if (message.type === 'snapshot') snapshots++;
        if (message.type === 'ack' && !message.ok) failures.push(message);
      }),
    );
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await adapted(source, viewer);
    await viewer.waitForFunction(
      () => {
        const video = document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector<HTMLVideoElement>('#clip');
        return video && video.getVideoPlaybackQuality().totalVideoFrames > 3;
      },
      null,
      { timeout: 5000 },
    );
    const stream = await viewer
      .frameLocator('#viewport iframe')
      .locator('#clip')
      .evaluate((v: HTMLVideoElement) => ({
        id: (v.srcObject as MediaStream).id,
        frames: v.getVideoPlaybackQuality().totalVideoFrames,
      }));
    await viewer.setViewportSize({ width: 740, height: 1000 });
    await adapted(source, viewer);
    assert.equal(
      await source
        .locator('#layout')
        .evaluate(
          (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length,
        ),
      1,
    );
    await clickProjected(
      viewer.frameLocator('#viewport iframe').locator('#edge'),
    );
    await source.waitForFunction(() => (window as any).clicks === 1);
    for (const width of [850, 1000, 1250, 1500, 1100])
      await viewer.setViewportSize({ width, height: 780 });
    await adapted(source, viewer);
    assert.equal(
      await source
        .locator('#layout')
        .evaluate(
          (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length,
        ),
      2,
    );
    assert.equal(await source.evaluate(() => (window as any).loads), 1);
    assert.equal(
      snapshots,
      1,
      'Viewport changes preserve the document and projection epoch',
    );
    assert.deepEqual(failures, []);
    assert.equal(
      await viewer
        .frameLocator('#viewport iframe')
        .locator('#clip')
        .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).id),
      stream.id,
    );
    assert.ok(
      (await viewer
        .frameLocator('#viewport iframe')
        .locator('#clip')
        .evaluate(
          (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames,
        )) > stream.frames,
      'Video continues decoding throughout resizing',
    );
    assert.equal(
      await viewer.locator('#connection-overlay').isVisible(),
      false,
    );
  },
);

test(
  'automatic sizing follows selected tabs and the controlling window',
  { timeout: 20000 },
  async (t) => {
    const site = await fixture();
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    let service: Awaited<ReturnType<typeof createProjectionServer>> | undefined;
    t.after(async () => {
      await service?.close();
      await browser.close();
      await site.close();
    });
    const sourceContext = await browser.newContext();
    const source = await sourceContext.newPage();
    await source.goto(site.url);
    service = await createProjectionServer(source, { authorize: () => true });
    const viewer = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    });
    viewer.setDefaultTimeout(4000);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await adapted(source, viewer);
    assert.equal(
      await viewer.getByLabel('Page size', { exact: true }).count(),
      0,
    );
    await viewer.setViewportSize({ width: 850, height: 700 });
    await adapted(source, viewer);
    await viewer.getByRole('button', { name: 'New tab', exact: true }).click();
    await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
    const newSource = source
      .context()
      .pages()
      .find((page) => page !== source)!;
    await adapted(newSource, viewer);
    await viewer.locator('#address').fill(`${site.url}/second`);
    await viewer.locator('#address').press('Enter');
    await viewer.frameLocator('#viewport iframe').locator('#second').waitFor();
    await adapted(newSource, viewer);
    const next = await browser.newPage({
      viewport: { width: 1100, height: 940 },
    });
    await next.goto(service.url);
    await next
      .getByRole('button', { name: 'Use in this window', exact: true })
      .click();
    await adapted(newSource, next);
    await viewer.locator('#status.disconnected').waitFor();
    await viewer.setViewportSize({ width: 1700, height: 1100 });
    await next
      .getByRole('tab', { name: 'Workspace · Juniper', exact: true })
      .click();
    await adapted(source, next);
    assert.deepEqual(newSource.viewportSize(), await dimensions(next));
    assert.equal(await next.locator('#toast').isVisible(), false);
  },
);

test(
  'resize requests coalesce while a prior resize is awaiting source authorization',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: unknown[] = [];
    const source = await browser.newPage();
    const service = await createProjectionServer(source, {
      authorize: async (action) => {
        if (action.kind === 'viewport') {
          requests.push(action);
          await gate;
        }
        return true;
      },
    });
    t.after(async () => {
      release();
      await service.close();
      await browser.close();
    });
    const viewer = await browser.newPage();
    let resizeSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      resizeSent = resolve;
    });
    const commands: unknown[] = [];
    viewer.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return;
        const message = JSON.parse(String(payload));
        if (message.action?.kind === 'viewport') {
          commands.push(message);
          resizeSent();
        }
      }),
    );
    await viewer.goto(service.url);
    await sent;
    for (const width of [740, 950, 1300, 1000])
      await viewer.setViewportSize({ width, height: 900 });
    assert.equal(
      commands.length,
      1,
      'A slow source cannot accumulate resize commands',
    );
    release();
    await adapted(source, viewer);
    assert.equal(
      requests.length,
      2,
      'Only the initial and latest pending size reach the source',
    );
  },
);
