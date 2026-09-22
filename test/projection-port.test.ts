import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectionPortConnection,
  serveProjectionPorts,
} from '../src/viewer/port.js';
import type {
  ProjectionConnection,
  ServerMessage,
  ClientMessage,
} from '../src/shared/protocol.js';
import type { MediaFrame } from '../src/shared/media-wire.js';

const wait = async (condition: () => boolean) => {
  const end = Date.now() + 2000;
  while (!condition() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), 'Expected port event was not delivered');
};

function fixture() {
  const messages = new MessageChannel(),
    media = new MessageChannel();
  const sent: ClientMessage[] = [];
  let emit: ((message: ServerMessage) => void | Promise<void>) | undefined;
  let frame: ((frame: MediaFrame) => void | Promise<void>) | undefined;
  let opened = 0,
    closed = 0;
  const source: ProjectionConnection = {
    send: (message) => {
      sent.push(message);
    },
    subscribe: (listener) => {
      emit = listener;
      return () => {
        emit = undefined;
      };
    },
    subscribeMedia: (listener) => {
      frame = listener;
      return () => {
        frame = undefined;
      };
    },
    onDisconnect: () => () => {},
    close: () => {
      closed++;
    },
  };
  const host = serveProjectionPorts(
    { messages: messages.port1, media: media.port1 },
    () => {
      opened++;
      return source;
    },
  );
  const viewer = projectionPortConnection({
    messages: messages.port2,
    media: media.port2,
  });
  return {
    host,
    viewer,
    sent,
    emit: (value: ServerMessage) => emit!(value),
    frame: (value: MediaFrame) => frame!(value),
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
  };
}
const command: ClientMessage = {
  type: 'command',
  id: 1,
  tab: 'source',
  epoch: 'epoch',
  action: { kind: 'text', text: 'one input' },
};
const frame = (): MediaFrame => ({
  header: {
    version: 1,
    target: 'source',
    view: 'observation',
    stream: 'video',
    node: 1,
    track: 'video',
    codec: 'vp8',
    timestamp_us: 0,
    duration_us: 10000,
    keyframe: true,
    width: 10,
    height: 10,
    bytes: 3,
  },
  data: new Uint8Array([1, 2, 3]),
});

test('projection ports credit each consumer independently and carry no environment authority', async (t) => {
  const state = fixture();
  t.after(() => {
    state.viewer.close();
    state.host.close();
  });
  const received: ServerMessage[] = [];
  state.viewer.subscribe((message) => {
    received.push(message);
  });
  let release!: () => void;
  const frames: MediaFrame[] = [];
  state.viewer.subscribeMedia!(async (value) => {
    frames.push(value);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await wait(() => state.opened === 1);
  await state.emit({ type: 'hello', version: 20, mediaWireVersion: 1 });
  assert.equal(received.length, 1);
  let consumed = false;
  const sending = Promise.resolve(state.frame(frame())).then(() => {
    consumed = true;
  });
  await wait(() => frames.length === 1);
  assert.equal(
    consumed,
    false,
    'Media credit cannot precede consumption in the destination document',
  );
  state.viewer.send(command);
  await wait(() => state.sent.length === 1);
  assert.deepEqual(state.sent, [command]);
  assert.equal(consumed, false, 'A stalled media document does not hold input');
  release();
  await sending;
  assert.equal(consumed, true);
  state.viewer.close();
  await wait(() => state.closed === 1);
  state.viewer.send(command);
  assert.equal(state.sent.length, 1, 'Closed window input is never replayed');
});

test('a bounded media port failure leaves the message and input port usable', async (t) => {
  const state = fixture();
  t.after(() => {
    state.viewer.close();
    state.host.close();
  });
  state.viewer.subscribeMedia!(async () => new Promise(() => {}));
  await wait(() => state.opened === 1);
  const large = frame();
  large.data = new Uint8Array(2 * 1024 * 1024);
  large.header.bytes = large.data.byteLength;
  const sending = Array.from({ length: 8 }, () =>
    Promise.resolve(state.frame(large)),
  );
  const results = await Promise.allSettled(sending);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(
    state.closed,
    0,
    'Media queue pressure does not revoke source input',
  );
  state.viewer.send(command);
  await wait(() => state.sent.length === 1);
});
