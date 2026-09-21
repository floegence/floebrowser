import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserText,
  englishMessages,
  type BrowserMessages,
} from '../src/viewer/messages.js';

test('hosts must supply complete translations with matching placeholders', () => {
  const missing = { ...englishMessages } as Partial<BrowserMessages>;
  delete missing['media.play'];
  assert.throws(() => browserText(missing as BrowserMessages), /media.play/);
  assert.throws(
    () => browserText({ ...englishMessages, 'media.play': ' ' }),
    /media.play/,
  );
  assert.throws(
    () =>
      browserText({ ...englishMessages, 'tabs.closeNamed': 'Close this page' }),
    /tabs.closeNamed/,
  );
  assert.throws(
    () =>
      browserText({ ...englishMessages, 'tabs.closeNamed': 'Close {page}' }),
    /tabs.closeNamed/,
  );
  const translated = browserText({
    ...englishMessages,
    'tabs.moved': '{total} total, position {position}',
  });
  assert.equal(
    translated('tabs.moved', { total: 4, position: 2 }),
    '4 total, position 2',
  );
  assert.equal(
    browserText()('tabs.closeNamed', { title: '$& {nested} <script>' }),
    'Close $& {nested} <script>',
  );
});
