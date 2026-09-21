import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { BrowserProjection } from '../dist/host/engine.js';
import { NativeMediaBridge } from '../dist/host/media-bridge.js';
import { mediaExecutable } from '../dist/host/media-executable.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

// Remote viewers can request decoder recovery, never supply ICE destinations.
test(
  'media authority survives DOM checkpoints but not navigation or revocation',
  { timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      chromiumSandbox: true,
    });
    const bridge = new NativeMediaBridge(mediaExecutable());
    t.after(async () => {
      await bridge.close();
      await browser.close();
    });
    const page = await browser.newPage();
    let frames = 0,
      keys = 0,
      collectors = 0;
    const projection = await BrowserProjection.attach(page, {
      authorize: () => true,
      onMediaFrame: () => {
        frames++;
      },
      mediaBridge: {
        close: () => bridge.close(),
        open: async (...args) => {
          collectors++;
          const subscription = await bridge.open(...args);
          return {
            ...subscription,
            requestKeyframe: async () => {
              keys++;
              await subscription.requestKeyframe();
            },
          };
        },
      },
    });
    t.after(() => projection.close());
    await page.goto('data:text/html,<video muted></video>');
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      let n = 0;
      setInterval(() => {
        ctx.fillStyle = n++ % 2 ? 'blue' : 'red';
        ctx.fillRect(0, 0, 300, 150);
      }, 40);
      const video = document.querySelector('video')!;
      video.srcObject = canvas.captureStream(25);
      await video.play();
    });
    const messages: ServerMessage[] = [];
    const connect = () =>
      projection.connect((message) => messages.push(message));
    const current = () =>
      messages.findLast((m) => m.type === 'media' && m.packet.kind === 'state');
    const wait = async (condition: () => boolean) => {
      const deadline = Date.now() + 8000;
      while (!condition() && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 20));
      assert.ok(condition());
    };
    const first = await connect();
    await wait(() => frames > 2 && !!current());
    const initial = current()!;
    assert.ok(initial.type === 'media' && initial.packet.kind === 'state');
    const feedback: Extract<ClientMessage, { type: 'media_keyframe' }> = {
      type: 'media_keyframe',
      tab: projection.id,
      view: initial.view,
      stream: initial.packet.stream,
    };
    for (const patch of [
      { tab: 'wrong' },
      { view: 'wrong' },
      { stream: 'wrong' },
    ])
      await first.receive({ ...feedback, ...patch });
    assert.equal(keys, 0, 'Invalid identities cannot reach the collector');
    await first.receive(feedback);
    assert.equal(keys, 1);
    const count = collectors;
    await first.receive({ type: 'resync' });
    await wait(
      () =>
        current()?.type === 'media' &&
        (current() as any).epoch !== initial.epoch,
    );
    assert.equal(
      collectors,
      count,
      'DOM-only checkpoints preserve the source media endpoints',
    );
    await first.receive(feedback);
    assert.equal(
      keys,
      2,
      'Media subscription generations do not depend on DOM checkpoint epochs',
    );
    await first.close();
    const stopped = frames;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(
      frames,
      stopped,
      'Revocation stops frame delivery synchronously',
    );
    messages.length = 0;
    const next = await connect();
    await wait(() => frames > stopped && !!current());
    const fresh = current()!;
    assert.ok(fresh.type === 'media' && fresh.packet.kind === 'state');
    assert.notEqual(fresh.view, initial.view);
    assert.notEqual(fresh.packet.stream, initial.packet.stream);
    await first.receive({
      ...feedback,
      view: fresh.view,
      stream: fresh.packet.stream,
    });
    await next.receive(feedback);
    assert.equal(
      keys,
      2,
      'Neither an old controller nor old media authority can request work',
    );
    await next.receive({
      ...feedback,
      view: fresh.view,
      stream: fresh.packet.stream,
    });
    assert.equal(keys, 3);
    assert.ok(
      messages.every((m) => m.type !== 'media' || !('sdp' in m.packet)),
      'SDP stays on the source host',
    );
    await page.goto('data:text/html,<h1>New document</h1>');
    const navigated = frames;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(frames, navigated);
    await next.close();
  },
);
