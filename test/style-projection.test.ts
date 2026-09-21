import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright';
import type { eventWithTime } from '@rrweb/types';
import { ResourceStore } from '../src/host/resources.js';
import { DOMProjection } from '../src/host/projection.js';

function resources(t: test.TestContext) {
  const store = new ResourceStore(new EventEmitter() as unknown as CDPSession);
  t.after(() => store.close());
  return store;
}

test('selector rewriting preserves operators, flags, namespaces and specificity', (t) => {
  const store = resources(t);
  const css = store.css(
    String.raw`a:is([href^="/news/" i], [h\72 ef$=".html"]):any-link, use[xlink|href], [constructor] {color:red} link + main, style + main {padding:1px}`,
    'https://source.test/',
  );
  assert.match(css, /data-floebrowser-href\^="\/news\/" i/);
  assert.match(css, /data-floebrowser-href\$="\.html"/);
  assert.match(css, /use\[data-floebrowser-xlink-href\]/);
  assert.match(css, /\[constructor\]/);
  assert.match(
    css,
    /:is\(link,style:where\(\[data-floebrowser-stylesheet-link\]\)\)/,
  );
  assert.match(
    css,
    /style:not\(:where\(\[data-floebrowser-stylesheet-link\]\)\)/,
  );
});

test('CSS URL escapes and image-set strings cannot escape the source resource route', (t) => {
  const store = resources(t);
  const base = 'https://source.test/css/layout.css';
  const reference = store.reference('../image one.svg', base);
  const rewritten = store.value(
    String.raw`image-set("../image\20 one.svg" 1x type("image/svg+xml"), url(../second.svg) 2x), url(jav\61script:alert)`,
    base,
  );
  assert.ok(rewritten.includes(reference));
  assert.match(rewritten, /type\("image\/svg\+xml"\)/);
  assert.match(rewritten, /\/_floe\/unavailable/);
  assert.doesNotMatch(rewritten, /javascript|\.svg|source\.test/);
  const imported = store.css(
    String.raw`@import './theme\20 one.css' layer(theme) screen;`,
    base,
  );
  assert.ok(imported.includes(store.reference('./theme one.css', base)));
  assert.match(imported, /layer\(theme\) screen/);
  assert.equal(
    store.value(String.raw`url(#local\"id)`, base),
    String.raw`url("#local\"id")`,
  );
});

test('raw selector values remain inert and source-supplied projection markers are discarded', (t) => {
  const store = resources(t);
  const projection = new DOMProjection(store);
  const input = {
    type: 2,
    timestamp: 1,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'a',
            attributes: {
              href: 'https://source.test/news/article',
              'data-floebrowser-href': 'forged',
            },
            floeAttributes: { href: '/news/article' },
            childNodes: [],
          },
          {
            type: 2,
            id: 3,
            tagName: 'div',
            attributes: {
              'data-floebrowser-stylesheet-link': '',
              'data-floebrowser-editable': 'true',
              'data-floebrowser-mathml': '',
              'data-floebrowser-focus': '',
              'data-floebrowser-hover': '',
              'data-floebrowser-active': '',
              'data-floebrowser-focus-visible': '',
              'data-floebrowser-focus-within': '',
              'data-floebrowser-input-proxy': '',
            },
            childNodes: [],
          },
        ],
      },
      initialOffset: { left: 0, top: 0 },
    },
  } as unknown as eventWithTime;
  const output = projection.event(input, 'https://source.test/') as any;
  assert.equal(output.data.node.childNodes[0].attributes.href, null);
  assert.equal(
    output.data.node.childNodes[0].attributes['data-floebrowser-href'],
    '/news/article',
  );
  assert.equal(output.data.node.childNodes[0].floeAttributes, undefined);
  assert.deepEqual(output.data.node.childNodes[1].attributes, {});
});

test('whole-sheet replacements and declaration updates use their source frame base', (t) => {
  const store = resources(t);
  const projection = new DOMProjection(store);
  const base = 'https://frame.test/styles/layout.css';
  for (const method of ['replace', 'replaceSync']) {
    const event = projection.event(
      {
        type: 3,
        timestamp: 1,
        data: {
          source: 8,
          styleId: 5,
          floeBase: base,
          [method]: 'a:any-link{background:url(../image.svg)}',
        },
      } as unknown as eventWithTime,
      'https://top.test/',
    ) as any;
    assert.ok(
      event.data[method].includes(store.reference('../image.svg', base)),
    );
    assert.match(event.data[method], /data-floebrowser-link/);
    assert.equal(event.data.floeBase, undefined);
  }
  const event = projection.event(
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 13,
        styleId: 5,
        floeBase: base,
        set: {
          property: 'background-image',
          value: 'url(../image.svg)',
          priority: '',
        },
      },
    } as unknown as eventWithTime,
    'https://top.test/',
  ) as any;
  assert.ok(
    event.data.set.value.includes(store.reference('../image.svg', base)),
  );
  assert.equal(event.data.floeBase, undefined);
});

test('source interaction selectors preserve pseudo specificity without rewriting strings or escaped classes', (t) => {
  const store = resources(t);
  const css = store.css(
    String.raw`section:focus-within input:focus-visible, button:hover:active, :not(:focus), .focus\:hover[data-label=":hover"] {color:red}`,
    'https://source.test/',
  );
  assert.match(
    css,
    /section\[data-floebrowser-focus-within\] input\[data-floebrowser-focus-visible\]/,
  );
  assert.match(
    css,
    /button\[data-floebrowser-hover\]\[data-floebrowser-active\]/,
  );
  assert.match(css, /:not\(\[data-floebrowser-focus\]\)/);
  assert.ok(css.includes(String.raw`.focus\:hover[data-label=":hover"]`));
});
