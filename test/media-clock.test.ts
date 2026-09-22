import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignMediaTimestamp,
  type MediaClock,
} from '../src/viewer/media-clock.js';

test('aligns independent audio and video timestamp origins once', () => {
  const clock: MediaClock = {};
  assert.equal(alignMediaTimestamp(clock, 'video', 772_884), 772_884);
  assert.equal(alignMediaTimestamp(clock, 'audio', 881_667), 772_884);
  assert.equal(alignMediaTimestamp(clock, 'video', 1_772_884), 1_772_884);
  assert.equal(alignMediaTimestamp(clock, 'audio', 1_881_667), 1_772_884);
});

test('does not manufacture a timeline for a non-finite timestamp', () => {
  const clock: MediaClock = {};
  assert.equal(alignMediaTimestamp(clock, 'audio', Number.NaN), Number.NaN);
  assert.deepEqual(clock, {});
});
