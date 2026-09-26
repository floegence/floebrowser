import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientMessageSchema,
  mediaPacketSchema,
} from '../src/shared/protocol.js';

const command = (action: unknown) => ({
  type: 'command',
  tab: 'source-tab',
  id: 1,
  epoch: 'current',
  action,
});

test('rejects remote commands with active URLs, oversized text, or extra authority', () => {
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

test('source mute requires an explicit boolean and cannot carry seek parameters', () => {
  const action = { kind: 'media', node: 1, operation: 'mute' };
  for (const muted of [true, false])
    assert.equal(
      clientMessageSchema.safeParse(command({ ...action, muted })).success,
      true,
    );
  for (const invalid of [
    action,
    { ...action, muted: 'true' },
    { ...action, muted: null },
    { ...action, muted: true, time: 1 },
    { ...action, operation: 'play', muted: true },
  ])
    assert.equal(
      clientMessageSchema.safeParse(command(invalid)).success,
      false,
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

test('file replies contain bounded opaque identities and cannot nominate source paths', () => {
  for (const [files, valid] of [
    [null, true],
    [['a'.repeat(32)], true],
    [['/etc/passwd'], false],
    [['../private'], false],
    [Array(129).fill('a'.repeat(32)), false],
  ] as const)
    assert.equal(
      clientMessageSchema.safeParse({
        type: 'command',
        id: 1,
        tab: 'tab',
        epoch: '',
        action: { kind: 'file_reply', chooser: 'request', files },
      }).success,
      valid,
    );
});

test('held-input release cannot carry a new key, pointer effect or extra authority', () => {
  assert.equal(
    clientMessageSchema.safeParse(command({ kind: 'release_input' })).success,
    true,
  );
  for (const extra of [{ key: 'Enter' }, { node: 1 }, { allTargets: true }])
    assert.equal(
      clientMessageSchema.safeParse(
        command({ kind: 'release_input', ...extra }),
      ).success,
      false,
    );
});

test('held pointer viewport coordinates are bounded and cannot add arbitrary authority', () => {
  const action = {
    kind: 'pointer',
    phase: 'move',
    point: { space: 'viewport', node: 1, x: 0.5, y: 0.5 },
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clicks: 1,
  };
  assert.equal(clientMessageSchema.safeParse(command(action)).success, true);
  for (const patch of [
    { space: 'screen' },
    { x: 1.1 },
    { y: -0.1 },
    { node: 0 },
    { captured: true },
  ])
    assert.equal(
      clientMessageSchema.safeParse(
        command({ ...action, point: { ...action.point, ...patch } }),
      ).success,
      false,
    );
});
