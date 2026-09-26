import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPopupIntent,
  consumePopupIntent,
  markPopupIntent,
} from '../src/host/popup-intent.js';

test('unmarked popups preserve native foreground behavior', () => {
  const source = {};
  assert.equal(consumePopupIntent(source), true);
});

test('popup intent preserves explicit foreground and background choices', () => {
  const source = {};
  markPopupIntent(source, true);
  assert.equal(consumePopupIntent(source), true);
  markPopupIntent(source, false);
  assert.equal(consumePopupIntent(source), false);
  assert.equal(consumePopupIntent(source), true);
});

test('clearing an old intent cannot remove a newer pointer decision', () => {
  const source = {};
  const old = markPopupIntent(source, true);
  markPopupIntent(source, false);
  clearPopupIntent(source, old);
  assert.equal(consumePopupIntent(source), false);
});
