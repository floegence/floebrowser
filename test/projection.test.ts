import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMProjection } from '../src/host/projection.js';
import { ResourceStore } from '../src/host/resources.js';
import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright';
import type { eventWithTime } from '@rrweb/types';

test('reconstructed HTML cannot navigate, submit, execute scripts, or directly load external assets', () => {
  const resources = new ResourceStore(
    new EventEmitter() as unknown as CDPSession,
  );
  const projection = new DOMProjection(resources);
  const elements = [
    [
      'img',
      {
        src: 'https://private.test/a.png',
        srcset: 'https://other.test/a.png 2x',
        onload: 'steal()',
      },
    ],
    ['a', { href: 'javascript:steal()', ping: 'https://other.test' }],
    [
      'iframe',
      { src: 'https://other.test', srcdoc: '<script>steal()</script>' },
    ],
    ['meta', { 'http-equiv': 'refresh', content: '0;url=https://other.test' }],
    ['script', { src: 'https://other.test/code.js' }],
    ['form', { action: 'https://other.test', target: '_top' }],
  ].map(([tagName, attributes], i) => ({
    type: 2,
    id: i + 2,
    tagName,
    attributes,
    childNodes: [],
  }));
  const event = {
    type: 2,
    timestamp: 1,
    data: {
      node: { type: 0, id: 1, childNodes: elements },
      initialOffset: { left: 0, top: 0 },
    },
  } as unknown as eventWithTime;
  const output: any = projection.event(event, 'https://private.test/');
  const nodes = output.data.node.childNodes;
  assert.match(nodes[0].attributes.src, /^\/_floe\/assets\//);
  assert.equal(nodes[0].attributes.srcset, null);
  assert.equal(nodes[0].attributes.onload, null);
  assert.equal(nodes[1].attributes.href, null);
  assert.equal(nodes[1].attributes['data-floebrowser-link'], '');
  assert.equal(nodes[2].tagName, 'iframe');
  assert.equal(nodes[2].attributes.src, null);
  assert.equal(nodes[2].attributes.srcdoc, null);
  assert.equal(nodes[2].attributes.sandbox, 'allow-same-origin');
  assert.equal(nodes[3].tagName, 'noscript');
  assert.equal(nodes[4].tagName, 'noscript');
  assert.equal(nodes[5].attributes.action, null);
  assert.equal(
    (event as any).data.node.childNodes[0].attributes.src,
    'https://private.test/a.png',
  );
  resources.close();
});

test('rewrites stylesheet imports and URLs without issuing network requests', async () => {
  const resources = new ResourceStore(
    new EventEmitter() as unknown as CDPSession,
  );
  const css = resources.css(
    '@import "../fonts.css"; .a { background:url(https://private.test/a.png); filter:url(#filter) }',
    'https://private.test/css/main.css',
  );
  assert.doesNotMatch(css, /https:|fonts\.css/);
  assert.match(css, /@import "\/_floe\/assets\//);
  assert.match(css, /url\("#filter"\)/);
  assert.equal(
    resources.reference('javascript:alert(1)', 'https://private.test'),
    '/_floe/unavailable',
  );
  assert.equal(await resources.read('unknown'), undefined);
  resources.close();
});

for (const invalid of ['width::564px', 'zoom;1']) {
  test(`preserves surrounding CSS and rewrites assets after ${invalid}`, () => {
    const resources = new ResourceStore(
      new EventEmitter() as unknown as CDPSession,
    );
    try {
      const css = resources.css(
        `@import "./theme.css"; .before { color: red } .legacy { ${invalid}; padding: 1px 0; background: url(./image.png) } .after { color: green }`,
        'https://source.test/css/main.css',
      );
      assert.match(css, /\.before\s*\{\s*color: red/);
      assert.match(css, /padding: 1px 0/);
      assert.match(css, /\.after\s*\{\s*color: green/);
      assert.match(css, /@import "\/_floe\/assets\//);
      assert.match(css, /background: url\("\/_floe\/assets\//);
      assert.doesNotMatch(css, /theme\.css|image\.png|https?:/);
    } finally {
      resources.close();
    }
  });
}

test('link selector rewriting preserves nested selectors, literals and escaped class names', () => {
  const resources = new ResourceStore(
    new EventEmitter() as unknown as CDPSession,
  );
  try {
    const css = resources.css(
      String.raw`
      :is(a:link, area:any-link):not(.disabled) { color: red; content: ":link"; }
      .literal\:link[data-label=":any-link"] { color: blue; }
      a:visited { color: purple; }
    `,
      'https://source.test/',
    );
    assert.match(
      css,
      /:is\(a\[data-floebrowser-link\], area\[data-floebrowser-link\]\):not\(\.disabled\)/,
    );
    assert.ok(css.includes(String.raw`.literal\:link[data-label=":any-link"]`));
    assert.match(css, /content: ":link"/);
    assert.match(css, /a:visited/);
  } finally {
    resources.close();
  }
});

test('frame attachment cannot replace a non-frame or the main replay document', () => {
  const resources = new ResourceStore(
    new EventEmitter() as unknown as CDPSession,
  );
  const projection = new DOMProjection(resources);
  projection.event(
    {
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
              tagName: 'div',
              attributes: {},
              childNodes: [],
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
    } as any,
    'https://source.test/',
  );
  const iframeDocument = {
    type: 3,
    timestamp: 2,
    data: {
      source: 0,
      isAttachIframe: true,
      adds: [
        {
          parentId: 2,
          nextId: null,
          node: {
            type: 0,
            id: 10,
            childNodes: [
              {
                type: 2,
                id: 11,
                tagName: 'html',
                attributes: {},
                childNodes: [],
              },
            ],
          },
        },
      ],
      removes: [],
      texts: [],
      attributes: [],
    },
  };
  assert.equal(
    projection.event(iframeDocument as any, 'https://source.test/'),
    undefined,
  );
  const mutation: any = projection.event(
    {
      type: 3,
      timestamp: 3,
      data: {
        source: 0,
        adds: [
          {
            parentId: 11,
            nextId: null,
            node: { type: 3, id: 12, textContent: 'Excluded frame content' },
          },
        ],
        removes: [],
        texts: [],
        attributes: [],
      },
    } as any,
    'https://source.test/',
  );
  assert.deepEqual(mutation.data.adds, []);
  resources.close();
});

test('media keeps its DOM geometry but cannot load site URLs or replay source playback', () => {
  const resources = new ResourceStore(
    new EventEmitter() as unknown as CDPSession,
  );
  const projection = new DOMProjection(resources);
  const snapshot: any = projection.event(
    {
      type: 2,
      timestamp: 1,
      data: {
        initialOffset: { left: 0, top: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'video',
              attributes: {
                src: 'https://site.test/private.mp4',
                controls: '',
                autoplay: '',
                class: 'player',
                width: '640',
                rr_mediaState: 'played',
                rr_mediaCurrentTime: 12,
              },
              childNodes: [
                {
                  type: 2,
                  id: 3,
                  tagName: 'source',
                  attributes: { src: 'https://site.test/source.mp4' },
                  childNodes: [],
                },
              ],
            },
          ],
        },
      },
    } as any,
    'https://site.test/',
  );
  const video = snapshot.data.node.childNodes[0];
  assert.equal(video.tagName, 'video');
  assert.equal(video.attributes.class, 'player');
  assert.equal(video.attributes.width, '640');
  assert.equal(video.attributes.src, null);
  assert.equal(video.attributes.controls, null);
  assert.equal(video.attributes.autoplay, null);
  assert.equal(video.attributes.rr_mediaState, undefined);
  assert.equal(video.attributes.rr_mediaCurrentTime, undefined);
  assert.equal(video.childNodes[0].tagName, 'noscript');
  const mutation: any = projection.event(
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        adds: [],
        removes: [],
        texts: [],
        attributes: [
          {
            id: 2,
            attributes: {
              src: 'blob:https://site.test/secret',
              autoplay: '',
              controls: '',
            },
          },
        ],
      },
    } as any,
    'https://site.test/',
  );
  assert.equal(mutation.data.attributes[0].attributes.src, null);
  resources.close();
});

test('canvas projection retains layout attributes without accepting bitmap payloads or fallback scripts', () => {
  const resources = new ResourceStore(
    new EventEmitter() as unknown as CDPSession,
  );
  const projection = new DOMProjection(resources);
  try {
    const output: any = projection.event(
      {
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
                tagName: 'canvas',
                floeCanvas: { width: 0, height: 120 },
                attributes: {
                  id: 'editor-overlay',
                  width: 0,
                  height: 120,
                  style: 'position:absolute;right:0',
                  rr_dataURL: 'data:image/png;base64,secret',
                  onclick: 'steal()',
                },
                childNodes: [
                  {
                    type: 2,
                    id: 3,
                    tagName: 'script',
                    attributes: {},
                    childNodes: [],
                  },
                ],
              },
            ],
          },
          initialOffset: { left: 0, top: 0 },
        },
      } as any,
      'https://source.test',
    );
    const canvas = output.data.node.childNodes[0];
    assert.equal(canvas.tagName, 'img');
    assert.equal(canvas.attributes.width, 0);
    assert.equal(canvas.attributes.height, 120);
    assert.equal(canvas.attributes.id, 'editor-overlay');
    assert.equal(canvas.attributes.onclick, null);
    assert.equal(canvas.attributes.rr_dataURL, undefined);
    assert.equal(canvas.attributes['data-floebrowser-canvas'], '');
    assert.match(canvas.attributes.src, /^data:image\/svg\+xml,/);
    assert.doesNotMatch(canvas.attributes.src, /secret/);
    assert.match(
      decodeURIComponent(canvas.attributes.src),
      /width="0" height="120"/,
    );
    assert.equal(canvas.floeCanvas, undefined);
    assert.deepEqual(canvas.childNodes, []);
    const update: any = projection.event(
      {
        type: 3,
        timestamp: 2,
        data: {
          source: 0,
          adds: [],
          texts: [],
          removes: [],
          attributes: [
            {
              id: 2,
              floeCanvas: { width: 40, height: 120 },
              attributes: {
                width: 40,
                rr_dataURL: 'data:image/png;base64,secret',
              },
            },
            { id: 3, attributes: { src: 'https://evil.test/code.js' } },
          ],
        },
      } as any,
      'https://source.test',
    );
    assert.equal(update.data.attributes.length, 1);
    assert.equal(update.data.attributes[0].attributes.width, 40);
    assert.equal(update.data.attributes[0].attributes.rr_dataURL, undefined);
    assert.equal(update.data.attributes[0].floeCanvas, undefined);
    assert.match(
      decodeURIComponent(update.data.attributes[0].attributes.src),
      /width="40" height="120"/,
    );
    const malformed: any = projection.event(
      {
        type: 3,
        timestamp: 3,
        data: {
          source: 0,
          adds: [],
          texts: [],
          removes: [],
          attributes: [
            {
              id: 2,
              attributes: {},
              floeCanvas: {
                width: '"><script>evil()</script>',
                height: -1,
              },
            },
          ],
        },
      } as any,
      'https://source.test',
    );
    const placeholder = decodeURIComponent(
      malformed.data.attributes[0].attributes.src,
    );
    assert.match(placeholder, /width="300" height="150"/);
    assert.doesNotMatch(placeholder, /script|evil/);
    assert.equal(
      projection.event(
        {
          type: 3,
          timestamp: 3,
          data: { source: 9, id: 2, property: 'drawImage', args: [] },
        } as any,
        'https://source.test',
      ),
      undefined,
    );
  } finally {
    resources.close();
  }
});
