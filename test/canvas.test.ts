import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CanvasFrames,
  CANVAS_CHUNK_BYTES,
  CANVAS_HEADER_BYTES,
  MAX_CANVAS_BYTES,
} from '../src/shared/canvas.js';

function chunk(
  id: number,
  offset: number,
  size: number,
  width = 300,
  height = 150,
) {
  const bytes = new Uint8Array(
    CANVAS_HEADER_BYTES + Math.min(CANVAS_CHUNK_BYTES, size - offset),
  );
  const header = new DataView(bytes.buffer);
  [id, width, height, size, offset].forEach((value, index) =>
    header.setUint32(index * 4, value),
  );
  bytes.fill(id, CANVAS_HEADER_BYTES);
  return bytes.buffer;
}

test('canvas assembly accepts unordered chunks, ignores duplicates and drops incomplete older frames', () => {
  const frames = new CanvasFrames();
  const size = CANVAS_CHUNK_BYTES + 80;
  assert.equal(frames.receive(chunk(1, CANVAS_CHUNK_BYTES, size)), undefined);
  assert.equal(frames.receive(chunk(1, CANVAS_CHUNK_BYTES, size)), undefined);
  assert.equal(frames.receive(chunk(2, 0, size)), undefined);
  assert.equal(frames.receive(chunk(1, 0, size)), undefined);
  const complete = frames.receive(chunk(2, CANVAS_CHUNK_BYTES, size))!;
  assert.equal(complete.width, 300);
  assert.equal(complete.height, 150);
  assert.equal(complete.bytes.length, size);
  assert.ok(complete.bytes.every((value) => value === 2));
  assert.equal(frames.receive(chunk(2, 0, size)), undefined);
  assert.equal(frames.receive(chunk(2, CANVAS_CHUNK_BYTES, size)), undefined);
});

test('canvas assembly rejects oversized, inconsistent and malformed packets before allocating', () => {
  const frames = new CanvasFrames();
  assert.equal(frames.receive(new ArrayBuffer(2)), undefined);
  assert.equal(frames.receive(chunk(1, 0, MAX_CANVAS_BYTES + 1)), undefined);
  assert.equal(frames.receive(chunk(1, 0, 32, 0)), undefined);
  assert.equal(frames.receive(chunk(1, 0, 32, 32769)), undefined);
  assert.equal(frames.receive(chunk(1, 1, 32)), undefined);
  assert.equal(frames.receive(chunk(1, 0, CANVAS_CHUNK_BYTES + 32)), undefined);
  assert.equal(
    frames.receive(chunk(1, CANVAS_CHUNK_BYTES, CANVAS_CHUNK_BYTES + 32, 400)),
    undefined,
  );
  assert.ok(frames.receive(chunk(2, 0, 32)));
});
