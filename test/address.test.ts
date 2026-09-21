import assert from 'node:assert/strict';
import test from 'node:test';
import { AddressSuggestions, addressURL } from '../src/viewer/address.js';

test('address input distinguishes websites, loopback ports, search and unsupported schemes', () => {
  for (const [input, result] of [
    ['example.com/path', 'https://example.com/path'],
    ['example.com:8443/path', 'https://example.com:8443/path'],
    ['localhost:8080/test', 'http://localhost:8080/test'],
    ['127.0.0.1:3000', 'http://127.0.0.1:3000/'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    [
      'https://example.com/?q=hello world',
      'https://example.com/?q=hello%20world',
    ],
    ['hello world', 'https://www.google.com/search?q=hello%20world'],
    [
      '中文搜索',
      'https://www.google.com/search?q=%E4%B8%AD%E6%96%87%E6%90%9C%E7%B4%A2',
    ],
    ['javascript:alert(1)', undefined],
    ['file:///tmp/test', undefined],
    ['https://user:secret@example.com/', undefined],
    ['', undefined],
  ])
    assert.equal(addressURL(input!), result, input);
});

test('suggestions deduplicate open tabs, match titles and bound in-memory visits', () => {
  const history = new AddressSuggestions();
  for (let i = 0; i < 110; i++)
    history.remember(`https://example.com/${i}`, `Page ${i}`);
  history.remember('about:blank', 'New tab');
  const tabs = {
    active: 'a',
    tabs: [{ id: 'a', title: 'Current page', url: 'https://example.com/109' }],
  };
  assert.deepEqual(history.match('Current', tabs), [
    { title: 'Current page', url: 'https://example.com/109', tab: 'a' },
  ]);
  assert.equal(history.match('https://example.com/0', tabs).length, 0);
  assert.equal(history.match('', tabs).length, 6);
  assert.equal(history.match('109', tabs).length, 1);
  assert.equal(history.match('New tab', tabs).length, 0);
});

test('host search policy is used only for submitted search terms and cannot create active URLs', () => {
  const queries: string[] = [];
  const search = (query: string) => {
    queries.push(query);
    return `https://search.example/?q=${encodeURIComponent(query)}`;
  };
  assert.equal(
    addressURL('example.com/path', search),
    'https://example.com/path',
  );
  assert.deepEqual(queries, []);
  assert.equal(
    addressURL('canvas examples', search),
    'https://search.example/?q=canvas%20examples',
  );
  assert.deepEqual(queries, ['canvas examples']);
  assert.equal(
    addressURL('search term', () => 'javascript:alert(1)'),
    undefined,
  );
  assert.equal(
    addressURL('search term', () => 'https://name:secret@example.com'),
    undefined,
  );
});
