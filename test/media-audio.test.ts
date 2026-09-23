import assert from 'node:assert/strict';
import test from 'node:test';
import { captureAudio } from '../src/host/media-audio.js';

class Track extends EventTarget {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class Samples {
  closed = false;
  sampleRate = 48000;
  numberOfFrames = 2;
  numberOfChannels = 2;
  data = new Float32Array([0.25, -0.5, 0.75, -1]);
  constructor(public timestamp: number) {}
  copyTo(output: Float32Array, { planeIndex }: { planeIndex: number }) {
    output.set(this.data.subarray(planeIndex * 2, planeIndex * 2 + 2));
  }
  close() {
    this.closed = true;
  }
}

function fixture(t: test.TestContext, ages: number[], reject = false) {
  let now = 1000000,
    index = 0,
    cancelled = false;
  const inputs: Samples[] = [],
    outputs: any[] = [];
  const native = globalThis as any;
  const previous = [
    native.MediaStreamTrackProcessor,
    native.MediaStreamTrackGenerator,
    native.AudioData,
  ];
  let output!: Track;
  let failed = 0;
  t.mock.method(performance, 'now', () => now / 1000);
  native.MediaStreamTrackProcessor = class {
    readable = new ReadableStream(
      {
        pull(controller) {
          if (index === ages.length) return;
          const value = new Samples(1000000 + index * 20000);
          now = value.timestamp + ages[index++]!;
          inputs.push(value);
          controller.enqueue(value);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    constructor(options: { track: Track; maxBufferSize: number }) {
      assert.equal(options.maxBufferSize, 1);
    }
  };
  native.MediaStreamTrackGenerator = class extends Track {
    writable = new WritableStream({
      write(value) {
        if (reject) throw new Error('Native sink ended');
        outputs.push(value);
      },
    });
    constructor() {
      super();
      output = this;
    }
  };
  native.AudioData = class {
    closed = false;
    constructor(value: object) {
      Object.assign(this, value);
    }
    close() {
      this.closed = true;
    }
  };
  const original = new Track();
  const capture = captureAudio(
    original as unknown as MediaStreamTrack,
    () => failed++,
  );
  t.after(() => {
    capture.close();
    [
      native.MediaStreamTrackProcessor,
      native.MediaStreamTrackGenerator,
      native.AudioData,
    ] = previous;
  });
  return {
    capture,
    original,
    inputs,
    outputs,
    get output() {
      return output;
    },
    get cancelled() {
      return cancelled;
    },
    get failed() {
      return failed;
    },
  };
}

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

test('native audio presentation timestamps reject dispatch jitter and preserve PCM', async (t) => {
  const state = fixture(t, [100000, 350000, 101000, 100000]);
  await drain();
  assert.deepEqual(
    state.outputs.map((value) => value.timestamp),
    [1200000, 1220000, 1240000, 1260000],
  );
  for (const value of state.outputs) {
    assert.deepEqual([...value.data], [0.25, -0.5, 0.75, -1]);
    assert.equal(value.sampleRate, 48000);
    assert.equal(value.numberOfFrames, 2);
    assert.equal(value.numberOfChannels, 2);
    assert.equal(value.closed, true);
  }
  assert.ok(state.inputs.every((value) => value.closed));
  state.capture.close();
  state.capture.close();
  await drain();
  assert.equal(state.original.stopped, true);
  assert.equal(state.output.stopped, true);
  assert.equal(state.cancelled, true);
  assert.equal(state.failed, 0);
});

test('already future-dated native audio is not shifted', async (t) => {
  const state = fixture(t, [-100000, -99500]);
  await drain();
  assert.deepEqual(
    state.outputs.map((value) => value.timestamp),
    [1000000, 1020000],
  );
});

test('latency estimation expires old device measurements in bounded input blocks', async (t) => {
  const state = fixture(t, [100000, ...Array(32).fill(150000), 70000]);
  await drain();
  const offset = (index: number) =>
    state.outputs[index].timestamp - state.inputs[index]!.timestamp;
  assert.equal(offset(1), 200000);
  assert.equal(offset(32), 300000);
  assert.equal(offset(33), 140000);
});

test('capture disposal cancels a pending read without reporting a media failure', async (t) => {
  const state = fixture(t, []);
  state.capture.close();
  await drain();
  assert.equal(state.cancelled, true);
  assert.equal(state.original.stopped, true);
  assert.equal(state.output.stopped, true);
  assert.equal(state.failed, 0);
});

test('native sink failure closes both owned tracks and reports one failure', async (t) => {
  const state = fixture(t, [100000], true);
  await drain();
  assert.equal(state.failed, 1);
  assert.equal(state.original.stopped, true);
  assert.equal(state.output.stopped, true);
  assert.equal(state.cancelled, true);
  assert.ok(state.inputs.every((value) => value.closed));
});

test('ending the captured source releases its generated audio track', async (t) => {
  const state = fixture(t, [100000]);
  await drain();
  state.original.dispatchEvent(new Event('ended'));
  await drain();
  assert.equal(state.output.stopped, true);
  assert.equal(state.cancelled, true);
  assert.equal(state.failed, 0);
});
