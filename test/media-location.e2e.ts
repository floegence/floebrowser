import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

async function setup(t: test.TestContext, framed = false) {
  let port = 0;
  const site = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      framed && req.url === '/'
        ? `<!doctype html><style>iframe{display:block;margin-top:1400px;margin-bottom:900px;width:620px;height:400px}</style><iframe src="http://localhost:${port}/frame"></iframe>`
        : `<!doctype html><title>Media location</title><style>body{margin:0}#scroller{margin-top:1300px;margin-bottom:900px;width:550px;height:360px;overflow:auto;scroll-behavior:smooth}#content{padding:850px 20px}video{display:block;width:320px;height:180px}</style><section id="scroller"><div id="content"><video id="clip" aria-label="Featured video" muted></video><video id="paused" aria-label="Paused video" muted></video><audio id="hidden" aria-label="Background audio"></audio></div></section><script>
      const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180;
      const ctx=canvas.getContext('2d'); let n=0;
      setInterval(()=>{ctx.fillStyle=++n%2?'#4688ab':'#306482';ctx.fillRect(0,0,320,180)},40);
      clip.srcObject=canvas.captureStream(25); clip.play();
      paused.srcObject=canvas.captureStream(25);
      </script>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, resolve));
  port = (site.address() as AddressInfo).port;
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    chromiumSandbox: true,
  });
  let service: Awaited<ReturnType<typeof createProjectionServer>> | undefined;
  let release: (() => void) | undefined;
  t.after(async () => {
    release?.();
    await service?.close();
    await browser.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });
  const source = await browser.newPage();
  source.setDefaultTimeout(5000);
  await source.goto(`http://127.0.0.1:${port}/`);
  const frame = framed
    ? source.frames().find((f) => f.url().endsWith('/frame'))!
    : source.mainFrame();
  await frame.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#clip');
    return Boolean(video && !video.paused);
  });
  const actions: any[] = [];
  let allowed = true;
  let gate: Promise<void> | undefined;
  service = await createProjectionServer(source, {
    authorize: async (action) => {
      actions.push(action);
      if (action.kind === 'media' && action.operation === 'reveal') {
        await gate;
        return allowed;
      }
      return true;
    },
  });
  const viewer = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  viewer.setDefaultTimeout(5000);
  await viewer.goto(service.url);
  await viewer.locator('#status.live').waitFor();
  const toggle = viewer.getByRole('button', {
    name: 'Media controls',
    exact: true,
  });
  await toggle.click();
  const panel = viewer.getByRole('dialog', {
    name: 'Media controls',
    exact: true,
  });
  const row = panel
    .locator('.floe-media-row')
    .filter({ hasText: 'Featured video' });
  await row.waitFor();
  return {
    source,
    frame,
    viewer,
    panel,
    row,
    toggle,
    actions,
    deny() {
      allowed = false;
    },
    block() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    unblock() {
      release?.();
    },
  };
}

for (const framed of [false, true])
  test(`locating website-autoplayed media scrolls the source without starting playback: cross-origin=${framed}`, async (t) => {
    const s = await setup(t, framed);
    assert.equal(
      s.actions.some((a) => a.kind === 'media'),
      false,
      'Attaching and opening controls never sends play to the source',
    );
    assert.equal(
      await s.frame
        .locator('#paused')
        .evaluate((v: HTMLVideoElement) => v.paused),
      true,
    );
    const locate = s.row.getByRole('button', {
      name: 'Show on page',
      exact: true,
    });
    await locate.click();
    await s.panel.waitFor({ state: 'hidden' });
    await s.source.waitForFunction(() => scrollY > 800);
    await s.frame.waitForFunction(
      () => document.querySelector('#scroller')!.scrollTop > 600,
    );
    const projected = framed
      ? s.viewer.frameLocator('#viewport iframe').frameLocator('iframe')
      : s.viewer.frameLocator('#viewport iframe');
    await projected.locator('#clip').evaluate((v) => {
      if (!v.getAnimations().length)
        throw new Error('Located media needs a visible highlight');
    });
    await s.viewer.waitForFunction((framed) => {
      const outer =
        document.querySelector<HTMLIFrameElement>(
          '#viewport iframe',
        )!.contentDocument!;
      const doc = framed
        ? outer.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!
        : outer;
      return (
        outer.defaultView!.scrollY > 800 &&
        doc.querySelector('#scroller')!.scrollTop > 600
      );
    }, framed);
    assert.equal(
      await s.frame
        .locator('#clip')
        .evaluate((v: HTMLVideoElement) => v.paused),
      false,
    );
    assert.equal(
      s.actions.filter((a) => a.kind === 'media' && a.operation === 'reveal')
        .length,
      1,
    );
    assert.equal(
      s.actions.some((a) => a.kind === 'media' && a.operation === 'play'),
      false,
    );
    await s.toggle.click();
    const paused = s.panel
      .locator('.floe-media-row')
      .filter({ hasText: 'Paused video' });
    await paused
      .getByRole('button', { name: 'Show on page', exact: true })
      .click();
    await s.panel.waitFor({ state: 'hidden' });
    assert.equal(
      await s.frame
        .locator('#paused')
        .evaluate((v: HTMLVideoElement) => v.paused),
      true,
      'Locating paused media never plays it',
    );
  });

test('denied media cannot scroll the source, and hidden audio never offers a fake location', async (t) => {
  const s = await setup(t);
  await s.row.getByText('Playing · Muted', { exact: true }).waitFor();
  s.deny();
  await s.row
    .getByRole('button', { name: 'Show on page', exact: true })
    .click();
  await s.viewer
    .getByText('The host did not authorize that action.', { exact: true })
    .waitFor();
  assert.equal(await s.source.evaluate(() => scrollY), 0);
  assert.equal(await s.panel.isVisible(), true);
  await s.frame.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>('#hidden')!;
    Object.defineProperty(audio, 'paused', { value: false });
    Object.defineProperty(audio, 'readyState', { value: 2 });
  });
  const hidden = s.panel
    .locator('.floe-media-row')
    .filter({ hasText: 'Background audio' });
  await hidden.waitFor();
  assert.equal(
    await hidden
      .getByRole('button', { name: 'Show on page', exact: true })
      .count(),
    0,
  );
  await hidden.getByText('No visible player', { exact: true }).waitFor();
});

test('a media element replaced during authorization cannot redirect a pending locate action', async (t) => {
  const s = await setup(t);
  s.block();
  await s.row
    .getByRole('button', { name: 'Show on page', exact: true })
    .click();
  await s.frame
    .locator('#clip')
    .evaluate((node) => node.replaceWith(node.cloneNode(true)));
  s.unblock();
  await s.viewer.locator('#toast:not([hidden])').waitFor();
  assert.equal(await s.source.evaluate(() => scrollY), 0);
  assert.equal(
    await s.frame.locator('#scroller').evaluate((node) => node.scrollTop),
    0,
  );
  assert.equal(
    await s.frame.locator('#clip').evaluate((v: HTMLVideoElement) => v.paused),
    true,
  );
  assert.equal(
    s.actions.filter(
      (action) => action.kind === 'media' && action.operation === 'reveal',
    ).length,
    1,
    'A stale locate is never replayed',
  );
  assert.equal(
    await s.viewer
      .frameLocator('#viewport iframe')
      .locator('#clip')
      .evaluate((node) =>
        node.getAnimations().some((a) => a.id === 'floe-media-location'),
      ),
    false,
  );
});
