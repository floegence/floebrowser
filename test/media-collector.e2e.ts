import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaExecutable } from '../dist/host/media-executable.js';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { NativeMediaBridge } from '../src/host/media-bridge.js';
import type { MediaFrame } from '../src/shared/media-wire.js';

for (const codec of ['vp8', 'h264'])
  test(
    `real Chromium ${codec} and Opus reach the client decoder without remote ICE`,
    { timeout: 30000 },
    async (t) => {
      const bridge = new NativeMediaBridge(mediaExecutable());
      const browser = await chromium.launch({
        channel: 'chromium',
        chromiumSandbox: true,
      });
      t.after(async () => {
        await bridge.close();
        await browser.close();
      });
      const source = await browser.newPage();
      const client = await browser.newPage();
      const files: Record<string, string> = {
        '/decoder.js': 'dist/viewer/media-decoder.js',
        '/worker.js': 'dist/assets/media-worker.js',
      };
      const server = createServer((req, res) => {
        const path = files[req.url ?? ''];
        if (!path) {
          res.end('<title>Media decoder</title>');
          return;
        }
        void readFile(path).then((data) => {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(data);
        });
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      t.after(() => new Promise<void>((done) => server.close(() => done())));
      await client.goto(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      );
      await client.evaluate(async () => {
        (window as any).RTCPeerConnection = class {
          constructor() {
            throw new Error('Client RTC is forbidden');
          }
        };
        const { ElementDecoder } = await import('/decoder.js');
        const results = ((window as any).decoded = {
          video: 0,
          audio: 0,
          bright: 0,
          signal: 0,
          errors: [],
        });
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const decoder = new ElementDecoder('/worker.js', (event: any) => {
          if (event.type === 'video') {
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(event.frame, 0, 0);
            const pixel = ctx.getImageData(80, 40, 1, 1).data;
            results.bright = Math.max(results.bright, pixel[0]!, pixel[1]!);
            results.video++;
            event.frame.close();
            decoder.painted();
          } else if (event.type === 'audio') {
            results.audio++;
            for (const channel of event.channels)
              for (const value of channel)
                results.signal = Math.max(results.signal, Math.abs(value));
            decoder.audioConsumed(event.channels[0].length);
          } else if (event.type === 'unavailable')
            results.errors.push(event.track);
        });
        (window as any).decoder = decoder;
      });
      const offer = await source.evaluate(async (codec) => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        document.body.append(canvas);
        const paint = canvas.getContext('2d')!;
        let frame = 0;
        setInterval(() => {
          paint.fillStyle = frame++ % 2 ? '#ff0000' : '#00ff00';
          paint.fillRect(0, 0, 160, 90);
        }, 30);
        const peer = new RTCPeerConnection({ iceServers: [] });
        (window as any).sourcePeer = peer;
        const stream = canvas.captureStream(25);
        const sender = peer.addTransceiver(stream.getVideoTracks()[0]!, {
          direction: 'sendonly',
          streams: [stream],
        });
        const capabilities = RTCRtpSender.getCapabilities(
          'video',
        )!.codecs.filter((c) => c.mimeType.toLowerCase() === `video/${codec}`);
        sender.setCodecPreferences(capabilities);
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        void audio.resume();
        peer.addTrack(
          destination.stream.getAudioTracks()[0]!,
          destination.stream,
        );
        await peer.setLocalDescription(await peer.createOffer());
        return peer.localDescription!.sdp;
      }, codec);
      const packets: MediaFrame[] = [];
      const subscription = await bridge.open(
        {
          target: 'target',
          view: 'view',
          stream: 'stream',
          node: 1,
          width: 160,
          height: 90,
        },
        offer,
        (p) => packets.push(p),
      );
      for (const line of subscription.sdp
        .split('\r\n')
        .filter((l) => l.startsWith('a=candidate:')))
        assert.equal(line.split(' ')[4], '127.0.0.1');
      await source.evaluate(async (sdp) => {
        await (window as any).sourcePeer.setRemoteDescription({
          type: 'answer',
          sdp,
        });
      }, subscription.sdp);
      const until = Date.now() + 10000;
      while (
        Date.now() < until &&
        (!packets.some((p) => p.header.track === 'video') ||
          !packets.some((p) => p.header.track === 'audio'))
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      const video = packets.find((p) => p.header.track === 'video');
      assert.ok(video, 'Encoded video arrived over the inherited binary pipe');
      assert.equal(video.header.keyframe, true);
      assert.equal(video.header.codec, codec);
      assert.equal(video.header.width, 160);
      assert.equal(video.header.height, 90);
      assert.equal(video.header.target, 'target');
      assert.ok(video.data.length > 10);
      assert.ok(
        packets.some((p) => p.header.track === 'audio'),
        'Opus audio arrived',
      );
      for (const packet of packets.slice())
        await client.evaluate(
          ({ header, data }) =>
            (window as any).decoder.push({
              header,
              data: new Uint8Array(data),
            }),
          { header: packet.header, data: [...packet.data] },
        );
      await client.waitForFunction(
        () =>
          (window as any).decoded.video > 0 &&
          (window as any).decoded.audio > 0,
      );
      const decoded = await client.evaluate(() => (window as any).decoded);
      assert.deepEqual(decoded.errors, []);
      assert.ok(decoded.bright > 200, 'WebCodecs produced the source image');
      assert.ok(decoded.signal > 0.01, 'Opus decoded to non-silent PCM');
      await Promise.all([subscription.requestKeyframe(), subscription.close()]);
      const count = packets.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(packets.length, count, 'Revocation stops delivery');
    },
  );
