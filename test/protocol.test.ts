import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientMessageSchema,
  mediaConfigurationSchema,
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

test('media accepts bounded signaling and host-owned ICE servers only', () => {
  assert.equal(
    mediaConfigurationSchema.safeParse({
      iceServers: [{ urls: 'https://website.test' }],
    }).success,
    false,
  );
  assert.equal(
    mediaConfigurationSchema.safeParse({ iceServers: [{ urls: [] }] }).success,
    false,
  );
  assert.equal(
    mediaConfigurationSchema.safeParse({
      iceServers: [
        {
          urls: 'turns:relay.example.test:443',
          username: 'temporary',
          credential: 'temporary',
        },
      ],
      iceTransportPolicy: 'relay',
    }).success,
    true,
  );
  assert.equal(
    mediaPacketSchema.safeParse({
      kind: 'chunk',
      id: 1,
      data: 'old encoded media',
    }).success,
    false,
  );
  const answer = {
    type: 'media_answer',
    tab: 'tab',
    epoch: 'epoch',
    node: 1,
    stream: 'stream',
    sdp: 'v=0\r\n',
  };
  assert.equal(clientMessageSchema.safeParse(answer).success, true);
  assert.equal(
    clientMessageSchema.safeParse({ ...answer, sdp: 'x'.repeat(48001) })
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
