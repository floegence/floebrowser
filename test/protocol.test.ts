import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientMessageSchema,
  mediaPacketSchema,
} from '../src/shared/protocol.js';

test('rejects remote commands with active URLs, oversized text, or extra authority', () => {
  const command = (action: unknown) => ({
    type: 'command',
    tab: 'source-tab',
    id: 1,
    epoch: 'current',
    action,
  });
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'chrome://settings',
    'data:text/html,hello',
  ]) {
    assert.equal(
      clientMessageSchema.safeParse(command({ kind: 'navigate', url })).success,
      false,
    );
  }
  assert.equal(
    clientMessageSchema.safeParse(
      command({ kind: 'text', text: 'x'.repeat(16001) }),
    ).success,
    false,
  );
  assert.equal(
    clientMessageSchema.safeParse({
      ...command({ kind: 'reload' }),
      admin: true,
    }).success,
    false,
  );
  assert.equal(
    clientMessageSchema.safeParse(
      command({ kind: 'navigate', url: 'https://example.com/' }),
    ).success,
    true,
  );
});

test('remote media feedback cannot inject ICE, SDP or encoded payloads into control', () => {
  assert.equal(
    mediaPacketSchema.safeParse({
      kind: 'offer',
      id: 1,
      stream: 'stream',
      sdp: 'v=0\r\n',
    }).success,
    false,
  );
  assert.equal(
    mediaPacketSchema.safeParse({ kind: 'chunk', id: 1, data: 'encoded media' })
      .success,
    false,
  );
  const feedback = {
    type: 'media_keyframe',
    tab: 'tab',
    view: 'view',
    stream: 'stream',
  };
  assert.equal(clientMessageSchema.safeParse(feedback).success, true);
  for (const patch of [
    { sdp: 'v=0' },
    { iceServers: [] },
    { stream: '' },
    { view: 'x'.repeat(81) },
  ])
    assert.equal(
      clientMessageSchema.safeParse({ ...feedback, ...patch }).success,
      false,
    );
  assert.equal(
    clientMessageSchema.safeParse({ ...feedback, type: 'media_answer' })
      .success,
    false,
  );
});

test('wheel commands require explicit scroll-region coordinates', () => {
  const wheel = {
    type: 'command',
    tab: 'source-tab',
    id: 1,
    epoch: 'current',
    action: {
      kind: 'wheel',
      point: { space: 'viewport', node: 1, x: 0.5, y: 0.5 },
      dx: 0,
      dy: 150,
      modifiers: 0,
    },
  };
  assert.equal(clientMessageSchema.safeParse(wheel).success, true);
  for (const point of [
    { node: 1, x: 0.5, y: 0.5 },
    { space: 'viewport', node: 1, x: 1.5, y: 0.5 },
    { space: 'viewport', node: 0, x: 0.5, y: 0.5 },
  ]) {
    assert.equal(
      clientMessageSchema.safeParse({
        ...wheel,
        action: { ...wheel.action, point },
      }).success,
      false,
    );
  }
});

test('viewport commands accept only bounded integer CSS dimensions', () => {
  for (const [width, height, valid] of [
    [1280, 800, true],
    [1, 1, true],
    [8192, 8192, true],
    [0, 600, false],
    [900, -1, false],
    [8193, 600, false],
    [900, 8193, false],
    [700.5, 600, false],
  ] as const) {
    assert.equal(
      clientMessageSchema.safeParse({
        type: 'command',
        id: 1,
        tab: 'tab',
        epoch: '',
        action: { kind: 'viewport', width, height },
      }).success,
      valid,
    );
  }
});

test('page zoom rejects unbounded or nonnumeric source density', () => {
  for (const [factor, valid] of [
    [0.25, true],
    [5, true],
    [1.5, true],
    [0, false],
    [0.24, false],
    [5.1, false],
    [NaN, false],
    [Infinity, false],
    ['1.5', false],
  ] as const)
    assert.equal(
      clientMessageSchema.safeParse({
        type: 'command',
        id: 1,
        tab: 'tab',
        epoch: '',
        action: { kind: 'zoom', factor },
      }).success,
      valid,
    );
});
