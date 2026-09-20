import assert from 'node:assert/strict';
import test from 'node:test';
import { clientMessageSchema } from '../src/shared/protocol.js';

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
