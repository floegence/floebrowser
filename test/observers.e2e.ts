import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { BrowserProjection } from '../dist/host/engine.js';
import { NativeMediaBridge } from '../dist/host/media-bridge.js';
import { mediaExecutable } from '../dist/host/media-executable.js';
import type { ServerMessage, Command } from '../src/shared/protocol.js';

const wait = async (condition: () => boolean) => {
  const end = Date.now() + 6000;
  while (!condition() && Date.now() < end)
    await new Promise((done) => setTimeout(done, 20));
  assert.ok(condition(), 'Expected observation state was not reached');
};

test(
  'viewing, control and media grants have independent revocation lifetimes',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      chromiumSandbox: true,
    });
    const source = await browser.newPage({
      viewport: { width: 900, height: 700 },
    });
    const bridge = new NativeMediaBridge(mediaExecutable());
    t.after(async () => {
      await bridge.close();
      await browser.close();
    });
    await source.goto(
      'data:text/html,<video width=160 height=90 muted></video><h1>Source</h1>',
    );
    await source.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const ctx = canvas.getContext('2d')!;
      let n = 0;
      setInterval(() => {
        ctx.fillStyle = ++n % 2 ? 'red' : 'blue';
        ctx.fillRect(0, 0, 160, 90);
      }, 40);
      const video = document.querySelector('video')!;
      video.srcObject = canvas.captureStream(25);
      await video.play();
    });
    let collectors = 0;
    const projection = await BrowserProjection.attach(source, {
      authorize: () => true,
      mediaBridge: {
        close: () => bridge.close(),
        open: (...args) => {
          collectors++;
          return bridge.open(...args);
        },
      },
    });
    t.after(() => projection.close());
    const a: ServerMessage[] = [],
      b: ServerMessage[] = [];
    let framesA = 0,
      framesB = 0;
    const first = await projection.observe((message) => a.push(message), {
      onMediaFrame: () => {
        framesA++;
      },
    });
    const second = await projection.observe((message) => b.push(message), {
      onMediaFrame: () => {
        framesB++;
      },
    });
    await wait(
      () =>
        a.some((m) => m.type === 'snapshot') &&
        b.some((m) => m.type === 'snapshot') &&
        framesA > 2 &&
        framesB > 2,
    );
    assert.equal(collectors, 1, 'Observers share one source element collector');
    assert.equal(projection.hasController, false);
    const resize: Command = {
      type: 'command',
      id: 1,
      tab: projection.id,
      epoch: '',
      action: { kind: 'viewport', width: 800, height: 600 },
    };
    await first.receive(resize);
    assert.deepEqual(
      source.viewportSize(),
      { width: 900, height: 700 },
      'A watch handle cannot dispatch input',
    );
    const control = await projection.acquireControl(first, () => true);
    await assert.rejects(() => projection.acquireControl(second, () => true));
    await control.receive(resize);
    assert.deepEqual(source.viewportSize(), { width: 800, height: 600 });
    await control.close();
    const receivedA = framesA,
      receivedB = framesB;
    await wait(() => framesA > receivedA + 2 && framesB > receivedB + 2);
    assert.equal(
      collectors,
      1,
      'Releasing input does not renegotiate authorized media',
    );
    await control.receive({
      ...resize,
      id: 2,
      action: { kind: 'viewport', width: 700, height: 500 },
    });
    assert.deepEqual(
      source.viewportSize(),
      { width: 800, height: 600 },
      'A revoked controller cannot regain authority',
    );
    await first.setMedia(false);
    const revoked = framesA,
      continued = framesB;
    await wait(() => framesB > continued + 2);
    assert.equal(framesA, revoked, 'Media revocation is scoped to its viewer');
    await second.close();
    const noView = framesB;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(framesB, noView);
    const beforeSnapshot = a.filter((m) => m.type === 'snapshot').length;
    await first.receive({ type: 'resync' });
    await wait(
      () => a.filter((m) => m.type === 'snapshot').length > beforeSnapshot,
    );
    const denied = await projection.acquireControl(first, () => false);
    await denied.receive({ ...resize, id: 3 });
    assert.ok(
      a.some((m) => m.type === 'ack' && m.id === 3 && m.code === 'not_allowed'),
    );
    await first.close();
    assert.equal(
      projection.hasController,
      false,
      'Closing a watch also revokes its associated input handle',
    );
  },
);
