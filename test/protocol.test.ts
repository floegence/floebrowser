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
