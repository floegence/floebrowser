import { clickProjected, hoverProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';
import { fixture } from './fixture.js';

async function setup(t: test.TestContext) {
  const site = await fixture();
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  const source = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await source.newPage();
  const service = await createProjectionServer(page, { authorize: () => true });
  const client = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
  });
  const viewer = await client.newPage();
  await viewer.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).WebSocket = class extends Original {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        if (String(args[0]).includes('/stream'))
          (window as any).testSocket = this;
      }
    };
  });
  const externalRequests: string[] = [];
  const errors: string[] = [];
  viewer.on('pageerror', (error) => errors.push(error.message));
  await client.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== new URL(service.url).origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  t.after(async () => {
    await client.close();
    await service.close();
    await browser.close();
    await site.close();
  });
  await page.goto(site.url, { waitUntil: 'networkidle' });
  await viewer.goto(service.url);
  await viewer.locator('#status.live').waitFor({ timeout: 15000 });
  const projected = viewer.frameLocator('#viewport iframe');
  await projected.locator('#count').waitFor();
  return {
    site,
    page,
    service,
    client,
    viewer,
    projected,
    externalRequests,
    errors,
  };
}

async function eventually(
  check: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(description);
}

test('projects authenticated DOM, images, CSS and fonts without client website requests', async (t) => {
  const { page, viewer, projected, externalRequests, errors } = await setup(t);
  assert.equal(
    await projected.locator('h1').textContent(),
    'Good morning, Jamie.',
  );
  await eventually(
    () =>
      projected
        .locator('#private-image')
        .evaluate(
          (image: HTMLImageElement) =>
            image.complete && image.naturalWidth === 48,
        ),
    'Private source image must load in the viewer',
  );
  assert.match(
    await projected
      .locator('.private-card')
      .evaluate((node) => getComputedStyle(node).backgroundImage),
    /url\("blob:/u,
  );
  await eventually(
    () =>
      projected.locator('body').evaluate(async () => {
        await document.fonts.ready;
        return Array.from(document.fonts).some(
          (font) => font.family === 'FixtureInter' && font.status === 'loaded',
        );
      }),
    'Private source font must load',
  );
  assert.equal(await page.evaluate(() => (window as any).fixtureRuns), 1);
  assert.equal(
    await projected.locator('body').evaluate(() => (window as any).fixtureRuns),
    undefined,
  );
  assert.equal(
    await projected.locator('[data-floebrowser-unsupported]').count(),
    0,
  );
  assert.equal(await projected.locator('[data-floebrowser-canvas]').count(), 1);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  await mkdir('.test-artifacts', { recursive: true });
  await viewer.screenshot({ path: '.test-artifacts/dom-projection.png' });
});

test('clicks, text input, IME, selects and form submission execute in the source browser', async (t) => {
  const { page, viewer, projected, site, externalRequests } = await setup(t);
  await clickProjected(projected.locator('#count'));
  await eventually(
    async () => (await page.locator('#count-value').textContent()) === '1',
    'Source receives the click',
  );
  assert.deepEqual(await page.evaluate(() => (window as any).trustedClicks), [
    true,
  ]);
  await eventually(
    async () => (await projected.locator('#count-value').textContent()) === '1',
    'Click result reaches the projection',
  );
  await clickProjected(projected.locator('#name'));
  await viewer.keyboard.type('Floe ');
  await viewer.keyboard.insertText('你好');
  await eventually(
    async () => (await page.locator('#name').inputValue()) === 'Floe 你好',
    'Text is entered in the source',
  );
  const clientCDP = await viewer.context().newCDPSession(viewer);
  await clientCDP.send('Input.imeSetComposition', {
    text: '世界',
    selectionStart: 2,
    selectionEnd: 2,
  });
  await clientCDP.send('Input.insertText', { text: '世界' });
  await eventually(
    async () => (await page.locator('#name').inputValue()) === 'Floe 你好世界',
    'IME commits exactly once in the source',
  );
  await hoverProjected(projected.locator('#region'));
  await viewer.locator('select.floe-input-proxy').selectOption('ap');
  await eventually(
    async () => (await page.locator('#region').inputValue()) === 'ap',
    'Selection reaches the source',
  );
  await clickProjected(projected.locator('#save'));
  await eventually(
    async () => site.submissions.length === 1,
    'Form submits once from the source',
  );
  assert.equal(site.submissions[0], 'Floe 你好世界|ap');
  await eventually(
    async () =>
      (await projected.locator('#result').textContent()) ===
      'Changes saved on the source',
    'Server result is projected',
  );
  assert.ok(
    site.requests
      .filter((request) => request.path === '/submit')
      .every((request) => request.cookie.includes('session=source-only')),
  );
  assert.deepEqual(externalRequests, []);
});

test('streams live mutations and scrolls the source without local navigation', async (t) => {
  const { page, viewer, projected, externalRequests } = await setup(t);
  await clickProjected(projected.locator('#mutate'));
  await projected.locator('#live-update').waitFor();
  await hoverProjected(projected.locator('h1'));
  await viewer.mouse.wheel(0, 480);
  await eventually(
    () => page.evaluate(() => scrollY > 100),
    'Wheel scrolls the source',
  );
  await eventually(
    () => projected.locator('body').evaluate(() => scrollY > 100),
    'Source scroll is projected',
  );
  await clickProjected(projected.locator('#next'));
  await eventually(
    async () => page.url().endsWith('/second'),
    'Link navigation happens at the source',
  );
  await projected.locator('#second').waitFor();
  assert.match(viewer.url(), /\/session\//);
  assert.deepEqual(externalRequests, []);
});

test('reconnects with a fresh document and never repeats prior input', async (t) => {
  const { page, viewer, projected } = await setup(t);
  await clickProjected(projected.locator('#count'));
  await eventually(
    async () => (await page.locator('#count-value').textContent()) === '1',
    'Initial action executes',
  );
  await viewer.evaluate(() => (window as any).testSocket.close());
  await viewer.locator('#status.disconnected').waitFor();
  await page.locator('#count').click();
  await viewer.locator('#reconnect').click();
  await viewer.locator('#status.live').waitFor();
  await eventually(
    async () => (await projected.locator('#count-value').textContent()) === '2',
    'Reconnect reflects current source state',
  );
  await clickProjected(projected.locator('#count'));
  await eventually(
    async () => (await page.locator('#count-value').textContent()) === '3',
    'Fresh controller executes one new click',
  );
});

test('explains an occupied browser and transfers control only on an explicit request', async (t) => {
  const { page, viewer, projected, client, service } = await setup(t);
  await clickProjected(projected.locator('#count'));
  await eventually(
    async () => (await page.locator('#count-value').textContent()) === '1',
    'The first viewer controls the source',
  );
  const second = await client.newPage();
  await second.goto(service.url);
  await second.locator('#status.disconnected').waitFor();
  assert.equal(
    await second.locator('#connection-title').textContent(),
    'This browser is open in another window',
  );
  assert.equal(await second.locator('#address').isDisabled(), true);
  assert.equal(await viewer.locator('#status.live').count(), 1);
  await second
    .getByRole('button', { name: 'Use in this window', exact: true })
    .click();
  await second.locator('#status.live').waitFor();
  await viewer.locator('#status.disconnected').waitFor();
  assert.equal(
    await viewer.locator('#connection-title').textContent(),
    'Control moved to another window',
  );
  const secondProjection = second.frameLocator('#viewport iframe');
  await clickProjected(secondProjection.locator('#count'));
  await eventually(
    async () => (await page.locator('#count-value').textContent()) === '2',
    'The new viewer controls the same source without replaying previous clicks',
  );
  await second.reload();
  await second.locator('#status.live').waitFor();
  await eventually(
    async () =>
      (await secondProjection.locator('#count-value').textContent()) === '2',
    'Refreshing the active window preserves the source and releases its old connection',
  );
  await second.close();
  await viewer
    .getByRole('button', { name: 'Use in this window', exact: true })
    .click();
  await viewer.locator('#status.live').waitFor();
  await clickProjected(projected.locator('#count'));
  await eventually(
    async () => (await page.locator('#count-value').textContent()) === '3',
    'The original window can recover after the other window closes',
  );
});

test('handles scaled input, double clicks, text selection, and multiline editing', async (t) => {
  const { page, viewer, projected } = await setup(t);
  await viewer.setViewportSize({ width: 900, height: 720 });
  // Responsive resizing is an asynchronous source command. Forced clicks on
  // inert replay nodes cannot use Playwright's normal geometry stability wait.
  await page.waitForFunction(() => innerWidth === 900);
  await viewer.waitForFunction(
    () =>
      document.querySelector<HTMLIFrameElement>('#viewport iframe')
        ?.contentWindow?.innerWidth === 900,
  );
  await clickProjected(projected.locator('#count'), { clickCount: 2 });
  await eventually(
    async () => (await page.locator('#count-value').textContent()) === '2',
    'Both clicks execute at the scaled source target',
  );
  await clickProjected(projected.locator('h1'), { clickCount: 3 });
  await eventually(
    () =>
      projected
        .locator('body')
        .evaluate(() => !!getSelection()?.toString().includes('Good morning')),
    'Projected text remains natively selectable',
  );
  await page.evaluate(() => {
    const editor = document.createElement('textarea');
    editor.id = 'multiline';
    editor.style.cssText =
      'position:fixed;top:100px;left:10px;width:300px;height:80px;z-index:100';
    document.body.append(editor);
  });
  await projected.locator('#multiline').waitFor();
  await clickProjected(projected.locator('#multiline'));
  await viewer.keyboard.type('line one');
  await viewer.keyboard.press('Enter');
  await viewer.keyboard.type('line two');
  await eventually(
    async () =>
      (await page.locator('#multiline').inputValue()) === 'line one\nline two',
    'Enter edits the source textarea',
  );
});

test('follows source redirects and manages new tabs, popups, switching and closing', async (t) => {
  const { page, viewer, projected, site, service } = await setup(t);
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'background-link';
    link.href = '/second';
    link.target = '_blank';
    link.textContent = 'Open a background source tab';
    link.style.cssText = 'position:fixed;top:10px;left:300px;z-index:100';
    document.body.append(link);
  });
  await clickProjected(projected.locator('#background-link'), {
    button: 'middle',
  });
  await viewer.getByRole('tab', { name: 'Second page', exact: true }).waitFor();
  assert.equal(
    await viewer.locator('#address').inputValue(),
    `${site.url}/`,
    'A middle-clicked popup stays in the background',
  );
  assert.equal(page.context().pages().length, 2);
  await viewer
    .getByRole('button', { name: 'Close Second page', exact: true })
    .click();
  await eventually(
    async () => page.context().pages().length === 1,
    'Closing the background popup removes only that source tab',
  );
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'popup-link';
    link.href = '/second';
    link.target = '_blank';
    link.textContent = 'Open a source tab';
    link.style.cssText = 'position:fixed;top:10px;left:500px;z-index:100';
    document.body.append(link);
  });
  await clickProjected(projected.locator('#popup-link'));
  await projected.locator('#second').waitFor();
  await viewer.getByRole('tab', { name: 'Second page', exact: true }).waitFor();
  assert.equal(page.context().pages().length, 2);
  assert.equal(
    await viewer.locator('#address').inputValue(),
    `${site.url}/second`,
  );
  await viewer
    .getByRole('tab', { name: 'Workspace · Juniper', exact: true })
    .click();
  await clickProjected(projected.locator('#count'));
  await eventually(
    async () => (await page.locator('#count-value').textContent()) === '1',
    'Switching returns control to the original page',
  );
  await viewer.getByRole('button', { name: 'New tab', exact: true }).click();
  await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
  assert.equal(await viewer.locator('#address').inputValue(), '');
  await viewer.locator('#address').fill(`${site.url}/redirect`);
  await viewer.locator('#address').press('Enter');
  await projected.locator('#second').waitFor();
  assert.equal(page.context().pages().length, 3);
  assert.match(viewer.url(), /\/session\//);
  await viewer
    .getByRole('tab', { name: 'Second page', exact: true })
    .last()
    .press('ArrowLeft');
  await eventually(
    async () =>
      service.session.currentState.active !==
      service.session.currentState.tabs.at(-1)!.id,
    'Keyboard navigation switches source tabs',
  );
  await viewer
    .getByRole('button', { name: 'Close Second page', exact: true })
    .last()
    .click();
  await eventually(
    async () => page.context().pages().length === 2,
    'Closing a background tab closes only that source tab',
  );
  await eventually(
    async () =>
      (await viewer
        .getByRole('button', { name: 'Close Second page', exact: true })
        .count()) === 1,
    'Closed source tabs leave the tab strip',
  );
  await viewer
    .getByRole('button', { name: 'Close Second page', exact: true })
    .click();
  await projected.locator('#count').waitFor();
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'script-popup';
    button.textContent = 'Script popup';
    button.style.cssText = 'position:fixed;top:10px;left:500px;z-index:101';
    button.onclick = () => window.open('/second', '_blank');
    document.body.append(button);
  });
  await clickProjected(projected.locator('#script-popup'));
  await projected.locator('#second').waitFor();
  await viewer
    .getByRole('button', { name: 'Close Second page', exact: true })
    .click();
  await projected.locator('#count').waitFor();
  await viewer
    .getByRole('button', { name: 'Close Workspace · Juniper', exact: true })
    .click();
  await viewer.getByRole('tab', { name: 'New tab', exact: true }).waitFor();
  assert.equal(page.context().pages().length, 1);
});

test('projects the source-selected responsive image after an image load', async (t) => {
  const { page, projected, externalRequests } = await setup(t);
  await page.locator('#private-image').evaluate((image: HTMLImageElement) => {
    image.srcset = '/private/retina.svg 1x';
  });
  await eventually(
    () =>
      projected
        .locator('#private-image')
        .evaluate(
          (image: HTMLImageElement) =>
            image.complete && image.naturalWidth === 64,
        ),
    'The source-selected image is projected',
  );
  assert.deepEqual(externalRequests, []);
});

test('keeps the source caret visible and supports insertion in the middle of text', async (t) => {
  const { page, viewer, projected } = await setup(t);
  await clickProjected(projected.locator('#name'));
  await viewer.keyboard.type('abcd');
  await eventually(
    async () => (await page.locator('#name').inputValue()) === 'abcd',
    'Initial source text is ready',
  );
  await viewer.keyboard.press('ArrowLeft');
  await viewer.keyboard.press('ArrowLeft');
  await eventually(
    () =>
      viewer
        .locator('.floe-input-proxy')
        .evaluate(
          (input: HTMLInputElement) =>
            document.activeElement === input && input.selectionStart === 2,
        ),
    'The host input control retains native focus and the source caret',
  );
  await viewer.keyboard.type('X');
  await eventually(
    async () => (await page.locator('#name').inputValue()) === 'abXcd',
    'Insertion respects source selection',
  );
  await eventually(
    () =>
      viewer
        .locator('.floe-input-proxy')
        .evaluate(
          (input: HTMLInputElement) =>
            input.value === 'abXcd' && input.selectionStart === 3,
        ),
    'The source caret follows the inserted text',
  );
  await viewer.locator('#address').focus();
  await page
    .locator('#name')
    .evaluate((input: HTMLInputElement) => input.setSelectionRange(0, 0));
  await viewer.waitForTimeout(50);
  assert.equal(
    await viewer
      .locator('#address')
      .evaluate((input) => document.activeElement === input),
    true,
    'Source focus updates cannot steal browser-chrome focus',
  );
});
