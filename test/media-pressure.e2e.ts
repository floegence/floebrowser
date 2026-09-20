import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { mediaNetwork } from './media-network.js';
import { createProjectionServer } from '../dist/host/server.js';

// High-motion synthetic source media. No display, camera or microphone capture.
test(
  'media pressure does not occupy the DOM transport and a paused frame survives resync',
  { timeout: 90000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
    const network = await mediaNetwork();
    t.after(() => network.close());
    const source = await browser.newPage();
    await source.exposeFunction('testRelayAnswer', (sdp: string) => {
      try {
        return network.rewrite(sdp, 1);
      } catch (e) {
        t.diagnostic(String(e));
        throw e;
      }
    });
    await source.addInitScript(() => {
      (window as any).sourcePeers = [];
      const Peer = RTCPeerConnection;
      (window as any).RTCPeerConnection = class extends Peer {
        constructor(c?: RTCConfiguration) {
          super(c);
          (window as any).sourcePeers.push(this);
        }
      };
      const original = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = async function (
        description: RTCSessionDescriptionInit,
      ) {
        return original.call(this, {
          ...description,
          sdp: await (window as any).testRelayAnswer(description.sdp),
        });
      };
    });
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    await source.goto(
      'data:text/html,<title>Media pressure</title><video id="clip" width="640" height="360" muted></video><button id="count" onclick="this.textContent=String(++window.clicks)">Count</button><script>window.clicks=0</script>',
    );
    await source.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d')!;
      let frame = 0;
      setInterval(() => {
        // Keep motion during the recovery color probe: an unchanged frame may
        // legitimately be suppressed by the native video encoder.
        frame++;
        ctx.fillStyle =
          (window as any).frameColor ?? (frame % 2 ? 'red' : 'blue');
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = 'white';
        ctx.fillText(String(frame), 30, 30);
      }, 30);
      const video = document.querySelector('video')!;
      video.srcObject = canvas.captureStream(30);
      await video.play();
    });
    const viewer = await browser.newPage();
    await viewer.exposeFunction('testRelayOffer', (sdp: string) => {
      try {
        return network.rewrite(sdp, 0);
      } catch (e) {
        t.diagnostic(String(e));
        throw e;
      }
    });
    await viewer.addInitScript(() => {
      (window as any).testPeers = [];
      const original = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = async function (
        description: RTCSessionDescriptionInit,
      ) {
        return original.call(this, {
          ...description,
          sdp: await (window as any).testRelayOffer(description.sdp),
        });
      };
      const Peer = RTCPeerConnection;
      (window as any).RTCPeerConnection = class extends Peer {
        constructor(c?: RTCConfiguration) {
          super(c);
          (window as any).testPeers.push(this);
        }
      };
      const Original = WebSocket;
      (window as any).WebSocket = class extends Original {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          (window as any).testSocket = this;
        }
      };
    });
    const mediaBytes: number[] = [];
    viewer.on('websocket', (ws) =>
      ws.on('framereceived', (e) => {
        const m = JSON.parse(String(e.payload));
        if (m.type === 'media' && m.packet.kind === 'chunk')
          mediaBytes.push(String(e.payload).length);
      }),
    );
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    const projected = viewer.frameLocator('#viewport iframe');
    const decoded = async () => {
      const end = Date.now() + 12000;
      while (Date.now() < end) {
        if (
          await projected
            .locator('video')
            .evaluate(
              (v: HTMLVideoElement) =>
                v.videoWidth > 0 &&
                v.videoWidth <= 640 &&
                v.getVideoPlaybackQuality().totalVideoFrames > 0,
            )
            .catch(() => false)
        )
          return;
        await new Promise((r) => setTimeout(r, 50));
      }
      t.diagnostic(
        JSON.stringify({
          relay: network.stats(),
          media: await projected
            .locator('video')
            .evaluate((v: HTMLVideoElement) => ({
              width: v.videoWidth,
              frames: v.getVideoPlaybackQuality().totalVideoFrames,
            })),
        }),
      );
      assert.fail('Projected media must have a decoded frame');
    };
    await decoded();
    assert.equal(
      mediaBytes.length,
      0,
      'Encoded media must not queue behind DOM and control messages',
    );
    const stats = () =>
      viewer.evaluate(async () => {
        const peers: RTCPeerConnection[] = (window as any).testPeers;
        const result = { frames: 0, lost: 0, bytes: 0 };
        for (const peer of peers)
          for (const report of (await peer.getStats()).values())
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
              result.frames += report.framesDecoded || 0;
              result.lost += report.packetsLost || 0;
              result.bytes += report.bytesReceived || 0;
            }
        return result;
      });
    const before = await stats();
    network.drop(true);
    const clickTimes: number[] = [];
    for (let i = 1; i <= 8; i++) {
      const start = performance.now();
      await projected.locator('#count').click();
      await source.waitForFunction((n) => (window as any).clicks === n, i, {
        timeout: 1500,
      });
      clickTimes.push(performance.now() - start);
      assert.ok(
        clickTimes.at(-1)! < 1500,
        'Source input stays responsive during media playback',
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    const impaired = await stats();
    assert.ok(
      network.stats().dropped > 20,
      'Real media packets are dropped during the outage',
    );
    assert.ok(
      impaired.frames < before.frames + 20,
      'The media outage stops new video frames',
    );
    await source.evaluate(() => ((window as any).frameColor = 'lime'));
    network.drop(false);
    const recoveryDeadline = Date.now() + 10000;
    while (
      (await stats()).frames < impaired.frames + 10 &&
      Date.now() < recoveryDeadline
    )
      await new Promise((r) => setTimeout(r, 100));
    const afterRecovery = await stats();
    if (afterRecovery.frames < impaired.frames + 10)
      t.diagnostic(
        JSON.stringify({
          relay: network.stats(),
          before,
          impaired,
          afterRecovery,
          source: await source.evaluate(async () => {
            const v = document.querySelector('video')!;
            return {
              paused: v.paused,
              frames: v.getVideoPlaybackQuality().totalVideoFrames,
              tracks: (v.srcObject as MediaStream)
                .getTracks()
                .map((t) => ({ id: t.id, state: t.readyState })),
              peers: await Promise.all(
                (window as any).sourcePeers.map(
                  async (p: RTCPeerConnection) => ({
                    state: p.connectionState,
                    senders: p.getSenders().map((s) => ({
                      state: s.track?.readyState,
                      enabled: s.track?.enabled,
                    })),
                    stats: [...(await p.getStats()).values()]
                      .filter((s) => s.type === 'outbound-rtp')
                      .map((s) => ({
                        frames: s.framesEncoded,
                        sent: s.packetsSent,
                        nack: s.nackCount,
                        pli: s.pliCount,
                      })),
                  }),
                ),
              ),
            };
          }),
        }),
      );
    assert.ok(
      afterRecovery.frames >= impaired.frames + 10,
      'Media resumes from new frames after congestion clears',
    );
    // Poll from the test runner: the replay iframe intentionally forbids script
    // timers, so awaiting setTimeout inside that sandbox would never resolve.
    const currentFrame = () =>
      projected.locator('video').evaluate((v: HTMLVideoElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(v, 0, 0, 1, 1);
        const p = ctx.getImageData(0, 0, 1, 1).data;
        return p[1]! > 180 && p[0]! < 80 && p[2]! < 80;
      });
    const currentDeadline = Date.now() + 5000;
    while (!(await currentFrame()) && Date.now() < currentDeadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      await currentFrame(),
      'Recovery must display current source frames instead of a stale video backlog',
    );
    await source.evaluate(() => delete (window as any).frameColor);
    // Continue moving video and source input for another 20 seconds after recovery.
    for (let i = 9; i <= 40; i++) {
      const start = performance.now();
      await projected.locator('#count').click();
      await source.waitForFunction((n) => (window as any).clicks === n, i, {
        timeout: 1500,
      });
      clickTimes.push(performance.now() - start);
      await new Promise((r) => setTimeout(r, 600));
    }
    assert.equal(await viewer.locator('#status').innerText(), 'Live');
    t.diagnostic(
      JSON.stringify({
        relay: network.stats(),
        before,
        impaired,
        recovered: await stats(),
        maxClickMs: Math.round(Math.max(...clickTimes)),
      }),
    );
    // Run beyond the old short-clip qualification and retain a paused frame during
    // repeated rrweb checkpoints without renegotiating or losing the receiver.
    const peerCount = await viewer.evaluate(
      () => (window as any).testPeers.length,
    );
    await source.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
    const old = await viewer.locator('#viewport iframe').elementHandle();
    await viewer.evaluate(() =>
      (window as any).testSocket.send(JSON.stringify({ type: 'resync' })),
    );
    await viewer.waitForFunction((node) => !node!.isConnected, old);
    await decoded();
    assert.equal(
      await viewer.evaluate(() => (window as any).testPeers.length),
      peerCount,
      'DOM resync keeps the existing media connection',
    );
    assert.equal(
      await viewer
        .locator('.floe-media-dock')
        .getByText(/exceeded|Reconnect/)
        .count(),
      0,
    );
  },
);
