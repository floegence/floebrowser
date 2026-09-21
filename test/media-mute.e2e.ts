import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

// These are actual idle source elements. Muting must not need capture, decode,
// readyState, a successful media URL or an implicit playback gesture.
test(
  'per-player muting changes only the authorized source element without playing it',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({ channel: 'chromium' });
    let service: Awaited<ReturnType<typeof createProjectionServer>> | undefined;
    t.after(async () => {
      await service?.close();
      await browser.close();
    });
    const source = await browser.newPage();
    source.setDefaultTimeout(4000);
    await source.goto(
      'data:text/html,' +
        encodeURIComponent(
          '<title>Source mute</title><video width=160 height=90 aria-label="First player"></video><video width=160 height=90 aria-label="Second player"></video>',
        ),
    );
    let allowed = true;
    const actions: any[] = [];
    service = await createProjectionServer(source, {
      authorize: (action) => {
        actions.push(action);
        return allowed;
      },
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(4000);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await viewer
      .getByRole('button', { name: 'Media controls', exact: true })
      .click();
    const row = viewer
      .locator('.floe-media-row')
      .filter({ hasText: 'Second player' });
    const mute = row.getByRole('button', {
      name: 'Mute source media',
      exact: true,
    });
    await mute.click();
    await source.waitForFunction(
      () => document.querySelectorAll('video')[1]!.muted,
    );
    await row
      .getByRole('button', { name: 'Unmute source media', exact: true })
      .waitFor();
    assert.deepEqual(
      await source
        .locator('video')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ muted: node.muted, paused: node.paused })),
        ),
      [
        { muted: false, paused: true },
        { muted: true, paused: true },
      ],
    );
    assert.deepEqual(
      actions
        .filter((a) => a.kind === 'media')
        .map((a) => [a.operation, a.muted]),
      [['mute', true]],
    );
    // The user's local action at the source must update the controls too.
    await source
      .locator('video')
      .nth(1)
      .evaluate((node) => (node.muted = false));
    await mute.waitFor();
    allowed = false;
    await mute.click();
    await viewer
      .getByText('The host did not authorize that action.', { exact: true })
      .waitFor();
    assert.equal(
      await source
        .locator('video')
        .nth(1)
        .evaluate((node) => node.muted),
      false,
    );
    assert.equal(
      await row
        .getByRole('button', { name: 'Mute source media', exact: true })
        .getAttribute('aria-pressed'),
      'false',
    );
    assert.equal(
      actions.filter((a) => a.kind === 'media' && a.operation === 'mute')
        .length,
      2,
      'Denied input is never retried',
    );
    allowed = true;
    await mute.click();
    await row
      .getByRole('button', { name: 'Unmute source media', exact: true })
      .click();
    await source.waitForFunction(
      () => !document.querySelectorAll('video')[1]!.muted,
    );
    assert.equal(
      actions.some((a) => a.kind === 'media' && a.operation === 'play'),
      false,
    );
  },
);
