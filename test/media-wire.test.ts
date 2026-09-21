import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MediaPacketReader,
  encodeMediaFrame,
  type MediaFrameHeader,
} from '../src/shared/media-wire.js';

const header: MediaFrameHeader = {
  version: 1,
  target: 'target',
  view: 'view',
  stream: 'stream',
  node: 1,
  track: 'video',
  codec: 'vp8',
  timestamp_us: 20000,
  duration_us: 40000,
  keyframe: true,
  width: 640,
  height: 360,
  bytes: 4,
};
test('media framing handles arbitrary stream fragmentation and multiple packets', () => {
  const encoded = encodeMediaFrame(header, new Uint8Array([0, 1, 2, 3]));
  const reader = new MediaPacketReader();
  const received = [];
  const both = new Uint8Array([...encoded, ...encoded]);
  for (let i = 0; i < both.length; i += 3)
    received.push(...reader.push(both.subarray(i, i + 3)));
  assert.equal(received.length, 2);
  assert.deepEqual(received[0]?.header, header);
  assert.deepEqual([...received[1]!.data], [0, 1, 2, 3]);
  reader.finish();
});
test('media framing rejects hostile lengths and incomplete stream termination', () => {
  assert.throws(
    () => new MediaPacketReader().push(new Uint8Array([127, 255, 255, 255])),
    /Invalid media/,
  );
  const reader = new MediaPacketReader();
  reader.push(encodeMediaFrame(header, new Uint8Array(4)).subarray(0, 7));
  assert.throws(() => reader.finish(), /Incomplete media/);
  assert.throws(
    () => encodeMediaFrame({ ...header, width: 100000 }, new Uint8Array(4)),
    /Invalid media/,
  );
  assert.throws(
    () => encodeMediaFrame({ ...header, view: '' }, new Uint8Array(4)),
    /Invalid media/,
  );
});
