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
  let keys = 0;
  const sender = new MediaSender(
    async (chunk) => {
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
    sender.acknowledge(200),
    false,
    'Future acknowledgements cannot mint credit',
  );
  sender.acknowledge(1);
  await tick();
  assert.equal(frames.length, 1, 'Dependent frames after a gap cannot escape');
  sender.push(packet(100, true));
  await tick();
  assert.equal(frames[1]?.header.timestamp_us, 100);
  sender.close();
  sender.push(packet(200, true));
  sender.acknowledge(2);
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
  const sender = new MediaSender(
    async (chunk) => {
      assert.ok(chunk.length <= 16384);
      frames.push(...reader.push(chunk));
    },
    () => {},
    { windowPackets: 1 },
  );
  const large = packet(0, true);
  large.data = new Uint8Array(100000);
  sender.push(large);
  sender.push(packet(1));
  sender.push(packet(2, true, 'audio'));
  await tick();
  sender.acknowledge(1);
  await tick();
  assert.equal(
    frames[1]?.header.track,
    'audio',
    'An active video lane cannot starve audio',
  );
  sender.close();
});
