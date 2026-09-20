import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { BrowserProjection } from '../dist/host/engine.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

test(
  'media answers are fenced by controller, tab, epoch, node and stream',
  { timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const projection = await BrowserProjection.attach(page, {
      authorize: () => true,
    });
    t.after(() => projection.close());
    await page.goto('data:text/html,<video muted></video>');
    await page.evaluate(async () => {
      (window as any).answers = 0;
      (window as any).peers = [];
      const Peer = RTCPeerConnection;
      (window as any).RTCPeerConnection = class extends Peer {
        constructor(c?: RTCConfiguration) {
          super(c);
          (window as any).peers.push(this);
        }
        setRemoteDescription(d: RTCSessionDescriptionInit) {
          (window as any).answers++;
          return super.setRemoteDescription(d);
        }
      };
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      setInterval(() => {
        ctx.fillStyle = 'blue';
        ctx.fillRect(0, 0, 300, 150);
      }, 40);
      const video = document.querySelector('video')!;
      video.srcObject = canvas.captureStream(25);
      await video.play();
    });
    const messages: ServerMessage[] = [];
    const connect = () =>
      projection.connect((message) => messages.push(message));
    const offer = async () => {
      const end = Date.now() + 8000;
      while (Date.now() < end) {
        const m = messages.findLast(
          (m) => m.type === 'media' && m.packet.kind === 'offer',
        );
        if (m?.type === 'media' && m.packet.kind === 'offer') return m;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('Source must publish a media offer');
    };
    const first = await connect();
    const initial = await offer();
    const answer: Extract<ClientMessage, { type: 'media_answer' }> = {
      type: 'media_answer',
      tab: projection.id,
      epoch: initial.epoch,
      node: initial.packet.id,
      stream: initial.packet.stream,
      sdp: 'v=0\r\n',
    };
    const count = () => page.evaluate(() => (window as any).answers);
    for (const patch of [
      { tab: 'stale' },
      { epoch: 'stale' },
      { node: 999999 },
      { stream: 'stale' },
    ])
      await first.receive({ ...answer, ...patch });
    assert.equal(
      await count(),
      0,
      'Invalid signaling must not reach the source peer',
    );
    await first.receive(answer);
    assert.equal(
      await count(),
      1,
      'Current signaling reaches the native SDP validator',
    );
    await first.receive({ type: 'resync' });
    await first.receive(answer);
    assert.equal(
      await count(),
      1,
      'A checkpoint invalidates the old answer epoch',
    );
    await first.close();
    assert.equal(
      await page.evaluate(() =>
        (window as any).peers.every(
          (p: RTCPeerConnection) => p.connectionState === 'closed',
        ),
      ),
      true,
    );
    messages.length = 0;
    const next = await connect();
    const current = await offer();
    assert.notEqual(current.packet.stream, initial.packet.stream);
    const fresh = {
      ...answer,
      epoch: current.epoch,
      node: current.packet.id,
      stream: current.packet.stream,
    };
    await first.receive(fresh);
    await next.receive({ ...fresh, stream: initial.packet.stream });
    assert.equal(
      await count(),
      1,
      'Neither revoked controllers nor retired streams can restart media',
    );
    await next.receive(fresh);
    assert.equal(await count(), 2);
    await next.close();
  },
);
