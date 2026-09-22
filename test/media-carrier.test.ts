import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaSender } from '../src/host/media-carrier.js';
import {
  MediaPacketReader,
  type MediaFrame,
} from '../src/shared/media-wire.js';

function packet(
  timestamp: number,
  keyframe = false,
  track: 'video' | 'audio' = 'video',
): MediaFrame {
  return {
    header: {
      version: 1,
      target: 'tab',
      view: 'view',
      stream: 'stream',
      node: 1,
      track,
      codec: track === 'video' ? 'vp8' : 'opus',
      keyframe,
      timestamp_us: timestamp,
      duration_us: 20000,
      width: track === 'video' ? 16 : undefined,
      height: track === 'video' ? 16 : undefined,
      bytes: 1,
    },
    data: new Uint8Array([1]),
  };
}
const tick = () => new Promise<void>((done) => setImmediate(done));

test('a stalled receiver has bounded media credit and resumes at a video keyframe', async () => {
  const frames: MediaFrame[] = [];
  const reader = new MediaPacketReader();
  let received = 0;
  let keys = 0;
  const sender = new MediaSender(
    async (chunk) => {
      received += chunk.length;
      frames.push(...reader.push(chunk));
    },
    () => {
      keys++;
    },
    { windowPackets: 1, queuedPackets: 2 },
  );
  sender.push(packet(0, true));
  await tick();
  for (let i = 1; i < 30; i++) sender.push(packet(i));
  await tick();
  assert.equal(frames.length, 1);
  assert.ok(keys > 0);
  assert.equal(
    sender.acknowledge(received + 1),
    false,
    'Future acknowledgements cannot mint credit',
  );
  sender.acknowledge(received);
  await tick();
  assert.equal(frames.length, 1, 'Dependent frames after a gap cannot escape');
  sender.push(packet(100, true));
  await tick();
  assert.equal(frames[1]?.header.timestamp_us, 100);
  sender.close();
  sender.push(packet(200, true));
  sender.acknowledge(received);
  await tick();
  assert.equal(
    frames.length,
    2,
    'Revocation stops even previously acknowledged lanes',
  );
});

test('media lanes schedule fairly and writes are no larger than 16 KiB', async () => {
  const frames: MediaFrame[] = [];
  const reader = new MediaPacketReader();
  let received = 0;
  const sender = new MediaSender(
    async (chunk) => {
      assert.ok(chunk.length <= 16384);
      received += chunk.length;
      frames.push(...reader.push(chunk));
    },
    () => {},
    { windowPackets: 1, windowBytes: 128 * 1024 },
  );
  const large = packet(0, true);
  large.data = new Uint8Array(100000);
  sender.push(large);
  sender.push(packet(1));
  sender.push(packet(2, true, 'audio'));
  await tick();
  sender.acknowledge(received);
  await tick();
  assert.equal(
    frames[1]?.header.track,
    'audio',
    'An active video lane cannot starve audio',
  );
  sender.close();
});

test('a frame larger than the byte window cannot fill the carrier before progressive consumption', async () => {
  const windowBytes = 32 * 1024;
  let received = 0,
    consumed = 0;
  const frames: MediaFrame[] = [],
    reader = new MediaPacketReader();
  const sender = new MediaSender(
    async (chunk) => {
      received += chunk.length;
      assert.ok(
        received - consumed <= windowBytes,
        'The byte window is a hard bound, including a partially sent picture',
      );
      frames.push(...reader.push(chunk));
    },
    () => {},
    { windowBytes },
  );
  const picture = packet(0, true);
  picture.data = new Uint8Array(128000);
  sender.push(picture);
  await tick();
  assert.equal(received, windowBytes, 'The sender pauses within a large frame');
  assert.equal(frames.length, 0);
  while (!frames.length) {
    assert.ok(sender.acknowledge(received));
    consumed = received;
    await tick();
  }
  assert.deepEqual(frames[0]?.data, picture.data);
  sender.close();
});
