import { clickProjected, hoverProjected } from './projected-input.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

async function setup(
  t: test.TestContext,
  html: string,
  files: Record<string, string> = {},
) {
  const site = createServer((request, response) => {
    const path = decodeURIComponent(request.url!);
    if (path.endsWith('.svg')) {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end(
        files[path] ??
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="green"/></svg>',
      );
    } else if (files[path] !== undefined) {
      response.writeHead(200, {
        'Content-Type': path.endsWith('.html') ? 'text/html' : 'text/css',
      });
      response.end(files[path]);
    } else if (path === '/page/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>${html.replaceAll('ASSET_ORIGIN', `http://localhost:${(site.address() as AddressInfo).port}`)}</body></html>`,
      );
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  const source = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const service = await createProjectionServer(source, {
    port: 0,
    authorize: () => true,
  });
  const viewer = await browser.newPage({
    viewport: { width: 1280, height: 884 },
  });
  const external: string[] = [];
  const errors: string[] = [];
  const failures: unknown[] = [];
  const commands = new Map<number, any>();
  viewer.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const message = JSON.parse(String(payload));
      if (message.type === 'command') commands.set(message.id, message.action);
    });
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const message = JSON.parse(String(payload));
      if (message.type !== 'ack') return;
      const action = commands.get(message.id);
      commands.delete(message.id);
      if (
        !message.ok &&
        !(
          action?.kind === 'pointer' &&
          action.phase === 'move' &&
          action.buttons === 0
        )
      )
        failures.push({ action: action?.kind, code: message.code });
    });
  });
  viewer.on('pageerror', (error) => errors.push(error.message));
  await viewer.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== new URL(service.url).origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  t.after(async () => {
    await browser.close();
    await service.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    assert.deepEqual(external, [], 'Website resources must stay at the source');
    assert.deepEqual(errors, []);
  });
  await source.goto(
    `http://127.0.0.1:${(site.address() as AddressInfo).port}/page/`,
    { waitUntil: 'networkidle' },
  );
  await viewer.goto(service.url);
  await viewer.locator('#status.live').waitFor();
  return {
    source,
    viewer,
    service,
    failures,
    root: viewer.frameLocator('#viewport iframe'),
  };
}
function appearance(node: Element) {
  const css = getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  return {
    width: rect.width,
    height: rect.height,
    display: css.display,
    color: css.color,
    padding: css.padding,
    border: css.borderLeftWidth,
    content: getComputedStyle(node, '::before').content,
  };
}
async function eventually(check: () => Promise<void>) {
  const end = Date.now() + 3000;
  while (true) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > end) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('raw URL and editable attribute selectors preserve initial and changed source styling', async (t) => {
  const { source, root } = await setup(
    t,
    `
    <style>
    #link, #image, #editor {display:inline-block; width:80px; color:gray}
    #link[href^="/article/"]:any-link {width:210px; color:rgb(1,2,3)}
    #link[href$="second"] {padding:7px}
    img[src$="first.svg"] {border-left:6px solid}
    #editor[contenteditable="true"] {width:170px}
    #responsive:not([src]) {padding:13px}
    </style>
    <a id="link" href="/article/first">Read more</a><img id="image" src="/first.svg"><div id="editor" contenteditable="true">Editor</div>
    <picture><source srcset="/first.svg"><img id="responsive"></picture>`,
  );
  assert.equal(
    await source
      .locator('#link')
      .evaluate((node) => node.getBoundingClientRect().width),
    210,
  );
  assert.equal(
    await source
      .locator('#editor')
      .evaluate((node) => node.getBoundingClientRect().width),
    170,
  );
  const verify = async () => {
    for (const selector of ['#link', '#image', '#editor', '#responsive'])
      assert.deepEqual(
        await root.locator(selector).evaluate(appearance),
        await source.locator(selector).evaluate(appearance),
        selector,
      );
  };
  await eventually(verify);
  await root
    .locator('#responsive')
    .evaluate((node: HTMLImageElement) => node.decode());
  await source.evaluate(() => {
    document.querySelector('#link')!.setAttribute('href', '/article/second');
    document.querySelector('#image')!.setAttribute('src', '/second.svg');
    document.querySelector('#editor')!.removeAttribute('contenteditable');
  });
  await eventually(verify);
  assert.equal(await root.locator('#link').getAttribute('href'), null);
  assert.equal(
    await root.locator('#editor').getAttribute('contenteditable'),
    null,
  );
});

test('SVG style text and external symbol references retain their source geometry', async (t) => {
  const { source, root } = await setup(
    t,
    `<svg width="100" height="40"><style id="svg-style">#shape{fill:rgb(1,2,3)}</style><rect id="shape" width="40" height="30"/></svg>
    <svg width="100" height="40"><use id="symbol" href="/symbols.svg#icon"/></svg>`,
    {
      '/symbols.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="icon" viewBox="0 0 40 30"><rect width="40" height="30" fill="green"/></symbol></svg>',
    },
  );
  const bounds = (node: Element) => {
    const rect = (node as SVGGraphicsElement).getBBox();
    return { width: rect.width, height: rect.height };
  };
  assert.ok((await source.locator('#symbol').evaluate(bounds)).width > 0);
  await eventually(async () =>
    assert.deepEqual(
      await root.locator('#symbol').evaluate(bounds),
      await source.locator('#symbol').evaluate(bounds),
    ),
  );
  for (const color of ['rgb(1, 2, 3)', 'rgb(4, 5, 6)']) {
    await source
      .locator('#svg-style')
      .evaluate(
        (node, color) => (node.textContent = `#shape{fill:${color}}`),
        color,
      );
    await eventually(async () =>
      assert.equal(
        await root
          .locator('#shape')
          .evaluate((node) => getComputedStyle(node).fill),
        color,
      ),
    );
  }
});

test('image-set strings and CSS escapes resolve through source resources', async (t) => {
  const { root } = await setup(
    t,
    `
    <link rel="stylesheet" href="ASSET_ORIGIN/styles/images.css">
    <div id="set" class="image"></div><div id="escaped" class="image"></div>`,
    {
      '/styles/images.css': String.raw`.image{width:40px;height:30px} #set{background-image:image-set("../first.svg" 1x, url("../second.svg") 2x)} #escaped{background-image:url(../image\20 one.svg)}`,
    },
  );
  for (const selector of ['#set', '#escaped']) {
    await eventually(async () => {
      const value = await root
        .locator(selector)
        .evaluate((node) => getComputedStyle(node).backgroundImage);
      assert.match(value, /\/session\/.*\/assets\//);
      assert.doesNotMatch(value, /\/styles\/|\.svg/);
    });
    await root.locator(selector).evaluate(async (node) => {
      const value = getComputedStyle(node).backgroundImage;
      const url = /url\("([^"]+)"\)/.exec(value)![1]!;
      const image = new Image();
      image.src = url;
      await image.decode();
    });
  }
});

test('constructed stylesheets keep resource and selector rewriting through replace and declaration edits', async (t) => {
  const { source, viewer, root } = await setup(
    t,
    `<a id="link" href="/article">Read</a><div id="card">Card</div><div id="shadow"></div>
  <script>
    window.sheet = new CSSStyleSheet();
    sheet.replaceSync('#card { width:100px; height:30px }');
    document.adoptedStyleSheets = [sheet];
    const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});
    shadow.innerHTML='<a id="shadow-link" href="/article">Shadow link</a>';
    shadow.adoptedStyleSheets=[sheet];
  </script>`,
  );
  for (const method of ['replaceSync', 'replace'] as const) {
    await source.evaluate(async (method) => {
      await (window as any).sheet[method](
        'a:any-link {display:block;width:230px;color:rgb(12,34,56)} #card {width:120px;height:30px;background:url("./first.svg")}',
      );
    }, method);
    await eventually(async () => {
      for (const selector of ['#link', '#shadow-link', '#card'])
        assert.deepEqual(
          await root.locator(selector).evaluate(appearance),
          await source.locator(selector).evaluate(appearance),
          `${method} ${selector}`,
        );
      assert.match(
        await root
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).backgroundImage),
        /\/session\/.*\/assets\//,
      );
    });
  }
  await source.evaluate(() =>
    (window as any).sheet.cssRules[1].style.setProperty(
      'background-image',
      'url("./second.svg")',
    ),
  );
  await eventually(async () =>
    assert.match(
      await root
        .locator('#card')
        .evaluate((node) => getComputedStyle(node).backgroundImage),
      /\/session\/.*\/assets\//,
    ),
  );
  await root.locator('#card').evaluate(async (node) => {
    const image = new Image();
    image.src = /url\("([^"]+)"\)/.exec(
      getComputedStyle(node).backgroundImage,
    )![1]!;
    await image.decode();
  });
  await viewer.reload();
  await viewer.locator('#status.live').waitFor();
  await eventually(async () => {
    for (const selector of ['#link', '#shadow-link', '#card'])
      assert.deepEqual(
        await root.locator(selector).evaluate(appearance),
        await source.locator(selector).evaluate(appearance),
      );
  });
});

test('external CSSOM edits resolve relative URLs against the stylesheet directory', async (t) => {
  const { source, root } = await setup(
    t,
    '<link id="sheet" rel="stylesheet" href="/styles/layout.css"><div id="card">Card</div>',
    {
      '/styles/layout.css': '#card {width:40px;height:30px}',
    },
  );
  await source.evaluate(() =>
    (document.querySelector('#sheet') as HTMLLinkElement).sheet!.insertRule(
      '#card{background-image:url("./first.svg")}',
    ),
  );
  await eventually(async () =>
    assert.match(
      await root
        .locator('#card')
        .evaluate((node) => getComputedStyle(node).backgroundImage),
      /\/session\/.*\/assets\//,
    ),
  );
  await root.locator('#card').evaluate(async (node) => {
    const image = new Image();
    image.src = /url\("([^"]+)"\)/.exec(
      getComputedStyle(node).backgroundImage,
    )![1]!;
    await image.decode();
  });
});

test('preloaded styles can activate and existing stylesheet links can change their URL', async (t) => {
  const { source, root } = await setup(
    t,
    '<link id="sheet" rel="preload" as="style" href="/styles/first.css"><div id="card">Card</div>',
    {
      '/styles/first.css':
        '#card {width:210px;color:rgb(1,2,3)} link + #card {padding:7px} style + #card {border-left:3px solid}',
      '/styles/second.css':
        '#card {width:180px;color:rgb(4,5,6)} link + #card {padding:4px} style + #card {border-left:3px solid}',
    },
  );
  await source
    .locator('#sheet')
    .evaluate((node) => node.setAttribute('rel', 'stylesheet'));
  await eventually(async () =>
    assert.deepEqual(
      await root.locator('#card').evaluate(appearance),
      await source.locator('#card').evaluate(appearance),
    ),
  );
  const loaded = source.waitForResponse((response) =>
    response.url().endsWith('/second.css'),
  );
  await source
    .locator('#sheet')
    .evaluate((node) => node.setAttribute('href', '/styles/second.css'));
  await loaded;
  await eventually(async () =>
    assert.deepEqual(
      await root.locator('#card').evaluate(appearance),
      await source.locator('#card').evaluate(appearance),
    ),
  );
  for (const disabled of [true, false]) {
    await source
      .locator('#sheet')
      .evaluate(
        (node, disabled) => ((node as HTMLLinkElement).disabled = disabled),
        disabled,
      );
    await eventually(async () =>
      assert.deepEqual(
        await root.locator('#card').evaluate(appearance),
        await source.locator('#card').evaluate(appearance),
      ),
    );
  }
  for (const media of ['print', 'screen']) {
    await source
      .locator('#sheet')
      .evaluate((node, media) => node.setAttribute('media', media), media);
    await eventually(async () =>
      assert.deepEqual(
        await root.locator('#card').evaluate(appearance),
        await source.locator('#card').evaluate(appearance),
      ),
    );
  }
});

test('cross-origin constructed stylesheets use the frame base URL through live edits', async (t) => {
  const { source, root } = await setup(
    t,
    '<iframe id="frame" src="ASSET_ORIGIN/frame/index.html"></iframe>',
    {
      '/frame/index.html': `<!doctype html><base href="/nested/"><div id="card">Child</div><script>
      window.sheet=new CSSStyleSheet(); sheet.replaceSync('#card{width:90px;height:30px}'); document.adoptedStyleSheets=[sheet];
    </script>`,
    },
  );
  const child = source
    .frames()
    .find((frame) => frame.url().endsWith('/frame/index.html'))!;
  const projected = root.frameLocator('#frame');
  await projected.locator('#card').waitFor();
  await child.evaluate(() =>
    (window as any).sheet.replaceSync(
      '#card{width:180px;height:30px;background:url("./child.svg")}',
    ),
  );
  await eventually(async () =>
    assert.deepEqual(
      await projected.locator('#card').evaluate(appearance),
      await child.locator('#card').evaluate(appearance),
    ),
  );
  await projected.locator('#card').evaluate(async (node) => {
    const image = new Image();
    image.src = /url\("([^"]+)"\)/.exec(
      getComputedStyle(node).backgroundImage,
    )![1]!;
    await image.decode();
  });
});

test('disabling a source stylesheet updates projected styling without changing the source DOM', async (t) => {
  const { source, service, root } = await setup(
    t,
    '<style id="sheet">#card{width:210px;color:rgb(1,2,3)}</style><div id="card">Card</div>',
  );
  for (const disabled of [true, false]) {
    await source
      .locator('#sheet')
      .evaluate(
        (node, disabled) =>
          ((node as HTMLStyleElement).sheet!.disabled = disabled),
        disabled,
      );
    await eventually(async () =>
      assert.deepEqual(
        await root.locator('#card').evaluate(appearance),
        await source.locator('#card').evaluate(appearance),
      ),
    );
  }
  await service.close();
  assert.equal(
    await source.evaluate(() =>
      Object.getOwnPropertyDescriptor(StyleSheet.prototype, 'disabled')!
        .set!.toString()
        .includes('[native code]'),
    ),
    true,
  );
});

test('disabled constructed sheets retain source edits and restore them on enable', async (t) => {
  const { source, viewer, root } = await setup(
    t,
    `<div id="card">Card</div><script>
    window.sheet=new CSSStyleSheet(); sheet.replaceSync('#card{width:210px;color:rgb(1,2,3)}');
    sheet.disabled=true; document.adoptedStyleSheets=[sheet];
  </script>`,
  );
  const verify = async () =>
    assert.deepEqual(
      await root.locator('#card').evaluate(appearance),
      await source.locator('#card').evaluate(appearance),
    );
  await eventually(verify);
  await source.evaluate(() =>
    (window as any).sheet.insertRule('#card{height:60px}'),
  );
  await eventually(verify);
  await source.evaluate(() => ((window as any).sheet.disabled = false));
  await eventually(verify);
  await source.evaluate(() => ((window as any).sheet.disabled = true));
  await viewer.reload();
  await viewer.locator('#status.live').waitFor();
  await eventually(verify);
  await source.evaluate(() => {
    (window as any).sheet.cssRules[0].style.setProperty('height', '80px');
    (window as any).sheet.disabled = false;
  });
  await eventually(verify);
});

test('cascade layers, container queries, generated content and open shadow DOM preserve layout after mutation', async (t) => {
  const { source, root } = await setup(
    t,
    `<style>
    @layer base, theme; @layer base {#card {color:red}} @layer theme {#card {color:rgb(1,2,3)}}
    #container {container-type:inline-size; width:400px} #card {height:30px}
    @container (min-width:300px) {#card {width:250px}} @container (max-width:299px) {#card{width:120px}}
    #card::before {content:attr(data-label)} @supports(display:grid) {#card{display:grid}}
    </style><div id="container"><div id="card" data-label="News">Card</div></div>
    <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<style>:host{display:block}p{width:180px;color:rgb(4,5,6)}</style><p id="shadow-card">Shadow</p>'</script>`,
  );
  const verify = async () => {
    for (const selector of ['#card', '#shadow-card'])
      assert.deepEqual(
        await root.locator(selector).evaluate(appearance),
        await source.locator(selector).evaluate(appearance),
      );
  };
  await eventually(verify);
  await source
    .locator('#container')
    .evaluate((node) => ((node as HTMLElement).style.width = '200px'));
  await eventually(verify);
});

test('root and nested scrollbar gutters preserve source content geometry and scrolling', async (t) => {
  const { source, viewer, root } = await setup(
    t,
    `
    <style>html{scrollbar-gutter:stable}body{margin:0;min-height:2400px}#scroll{width:300px;height:150px;overflow:auto;scrollbar-gutter:stable}#scroll::-webkit-scrollbar{width:18px}#scroll::-webkit-scrollbar-thumb{background:gray}#content{height:500px}#edge{width:100%}</style>
    <div id="edge">Full width</div><div id="scroll"><div id="content">Nested content</div></div>`,
  );
  const verify = async () => {
    for (const selector of ['#edge', '#scroll', '#content'])
      assert.deepEqual(
        await root.locator(selector).evaluate(appearance),
        await source.locator(selector).evaluate(appearance),
        selector,
      );
  };
  await eventually(verify);
  await hoverProjected(root.locator('#content'), {
    position: { x: 100, y: 100 },
  });
  await viewer.mouse.wheel(0, 160);
  await source.waitForFunction(
    () => document.querySelector('#scroll')!.scrollTop > 0,
  );
  await eventually(async () =>
    assert.equal(
      await root.locator('#scroll').evaluate((node) => node.scrollTop),
      await source.locator('#scroll').evaluate((node) => node.scrollTop),
    ),
  );
});

test('MathML retains native layout and node identities across live edits and reconstruction', async (t) => {
  const { source, viewer, root } = await setup(
    t,
    `
    <style>math{font-size:32px}#fraction{color:rgb(1,2,3)}</style>
    <math xmlns="http://www.w3.org/1998/Math/MathML" id="formula" display="block"><mfrac id="fraction"><mi>a</mi><msup><mi>b</mi><mn id="power">2</mn></msup></mfrac><mtext><span id="explanation"> units</span></mtext></math>`,
  );
  const verify = async () => {
    for (const selector of [
      '#formula',
      '#fraction',
      '#power',
      '#explanation',
    ]) {
      assert.equal(
        await root.locator(selector).evaluate((node) => node.namespaceURI),
        await source.locator(selector).evaluate((node) => node.namespaceURI),
        selector,
      );
      assert.deepEqual(
        await root.locator(selector).evaluate(appearance),
        await source.locator(selector).evaluate(appearance),
        selector,
      );
    }
  };
  await eventually(verify);
  await source.locator('#power').evaluate((node) => (node.textContent = '12'));
  await source
    .locator('#fraction')
    .evaluate((node) => node.setAttribute('linethickness', '4px'));
  await source
    .locator('#formula')
    .evaluate((node) =>
      node.insertAdjacentHTML('beforeend', '<mo id="equals">=</mo><mn>1</mn>'),
    );
  await eventually(verify);
  await eventually(async () =>
    assert.equal(
      await root.locator('#equals').evaluate((node) => node.namespaceURI),
      'http://www.w3.org/1998/Math/MathML',
    ),
  );
  await viewer.reload();
  await viewer.locator('#status.live').waitFor();
  await eventually(verify);
});

test(
  'custom-property border shorthands survive later longhand overrides',
  {
    todo: 'Chromium CSSOM drops pending shorthand values; requires authored stylesheet recovery',
  },
  async (t) => {
    const { source, root } = await setup(
      t,
      `<style>:root{--line:1px}#panel{width:200px;border:var(--line) solid;border-color:red}</style><div id="panel">Border</div>`,
    );
    await eventually(async () =>
      assert.deepEqual(
        await root.locator('#panel').evaluate(appearance),
        await source.locator('#panel').evaluate(appearance),
      ),
    );
  },
);

test('live entry animations reveal content and preserve explicitly paused source animations', async (t) => {
  const { source, viewer, root } = await setup(
    t,
    `
    <style>
      @keyframes reveal { from { opacity: 0 } to { opacity: 1 } }
      .entry { animation: reveal 120ms ease-out both; }
      .paused { animation-play-state: paused; }
      #pseudo::before { content: 'Animated label'; animation: reveal 120ms both; }
    </style>
    <section class="entry" id="entry"><button id="action" onclick="this.textContent='Confirmed'">Run action</button></section>
    <div class="entry paused" id="paused">Intentionally hidden</div>
    <div id="pseudo"></div>
  `,
  );
  const opacity = (node: Element) => getComputedStyle(node).opacity;
  assert.equal(await source.locator('#entry').evaluate(opacity), '1');
  await eventually(async () =>
    assert.equal(await root.locator('#entry').evaluate(opacity), '1'),
  );
  await eventually(async () =>
    assert.equal(
      await root
        .locator('#pseudo')
        .evaluate((node) => getComputedStyle(node, '::before').opacity),
      '1',
    ),
  );
  assert.equal(await root.locator('#paused').evaluate(opacity), '0');
  await clickProjected(root.locator('#action'));
  await source.waitForFunction(
    () => document.querySelector('#action')?.textContent === 'Confirmed',
  );
  await viewer.reload();
  await viewer.locator('#status.live').waitFor();
  await eventually(async () =>
    assert.equal(await root.locator('#entry').evaluate(opacity), '1'),
  );
});

test('canvas placeholders preserve editor overlays, hidden surfaces, native sizing and later layout changes', async (t) => {
  const { source, viewer, root, failures } = await setup(
    t,
    `
    <style>
      #editor { position:relative; width:480px; height:160px; overflow:auto; }
      canvas.overlay { position:absolute; right:0; top:0; width:14px; height:160px; pointer-events:none; }
      canvas.zero { width:0; }
      canvas.hidden { display:none; }
      img { display:block; margin:40px; width:500px; }
      #content { height:1800px; }
    </style>
    <div id="editor"><canvas id="overlay" class="overlay"></canvas><canvas id="zero" class="overlay zero"></canvas><canvas id="hidden" class="hidden"></canvas><div id="content"><button id="target" onclick="this.textContent='Confirmed'">Source action</button></div></div>
    <canvas id="intrinsic" width="200" height="80"></canvas><button id="after">After surface</button>
    <div><canvas id="width-only" width="200"></canvas><canvas id="height-only" height="80"></canvas><canvas id="defaults"></canvas></div>
  `,
  );
  const geometry = (node: Element) => {
    const r = node.getBoundingClientRect();
    const s = getComputedStyle(node);
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      display: s.display,
      position: s.position,
      pointerEvents: s.pointerEvents,
    };
  };
  for (const id of [
    'editor',
    'overlay',
    'zero',
    'hidden',
    'intrinsic',
    'after',
    'width-only',
    'height-only',
    'defaults',
  ]) {
    await eventually(async () =>
      assert.deepEqual(
        await root.locator(`#${id}`).evaluate(geometry),
        await source.locator(`#${id}`).evaluate(geometry),
      ),
    );
  }
  await clickProjected(root.locator('#target'));
  await source.waitForFunction(
    () => document.querySelector('#target')?.textContent === 'Confirmed',
  );
  await hoverProjected(root.locator('#editor'), {
    position: { x: 470, y: 80 },
  });
  await viewer.mouse.wheel(0, 300);
  await source.waitForFunction(
    () => document.querySelector('#editor')!.scrollTop >= 300,
  );
  await source.locator('#overlay').evaluate((node) => {
    node.style.width = '9px';
    node.style.height = '120px';
    node.style.right = '20px';
  });
  await eventually(async () =>
    assert.deepEqual(
      await root.locator('#overlay').evaluate(geometry),
      await source.locator('#overlay').evaluate(geometry),
    ),
  );
  await source
    .locator('#hidden')
    .evaluate((node) => node.classList.remove('hidden'));
  await eventually(async () =>
    assert.deepEqual(
      await root.locator('#hidden').evaluate(geometry),
      await source.locator('#hidden').evaluate(geometry),
    ),
  );
  for (const [id, attribute, value] of [
    ['width-only', 'width', '240'],
    ['height-only', 'height', null],
    ['intrinsic', 'width', null],
    ['defaults', 'height', '50'],
  ] as const) {
    await source.locator(`#${id}`).evaluate(
      (node, change) => {
        if (change.value === null) node.removeAttribute(change.attribute);
        else node.setAttribute(change.attribute, change.value);
      },
      { attribute, value },
    );
    await eventually(async () => {
      assert.deepEqual(
        await root.locator(`#${id}`).evaluate(geometry),
        await source.locator(`#${id}`).evaluate(geometry),
      );
      assert.equal(await root.locator(`#${id}`).getAttribute(attribute), value);
    });
  }
  assert.deepEqual(failures, []);
});

test('cross-origin frame animations and intrinsic canvas sizes survive projection and source updates', async (t) => {
  const { source, root, failures } = await setup(
    t,
    '<iframe id="child" src="ASSET_ORIGIN/child.html" width="700" height="450"></iframe>',
    {
      '/child.html': `<!doctype html><style>
      @keyframes reveal { from { opacity:0 } to { opacity:1 } }
      article { animation:reveal 100ms both; }
      canvas:not([height]) { margin-left:10px; }
    </style><article><canvas id="surface" width="200"></canvas><button onclick="document.querySelector('canvas').height=90">Resize surface</button></article>`,
    },
  );
  const child = root.frameLocator('#child');
  const sourceChild = source.frameLocator('#child');
  const size = (node: Element) => {
    const r = node.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  };
  await eventually(async () => {
    assert.equal(
      await child
        .locator('article')
        .evaluate((n) => getComputedStyle(n).opacity),
      '1',
    );
    assert.deepEqual(
      await child.locator('#surface').evaluate(size),
      await sourceChild.locator('#surface').evaluate(size),
    );
  });
  await clickProjected(child.getByRole('button', { name: 'Resize surface' }));
  await eventually(async () => {
    assert.equal(
      await sourceChild.locator('#surface').getAttribute('height'),
      '90',
    );
    assert.deepEqual(
      await child.locator('#surface').evaluate(size),
      await sourceChild.locator('#surface').evaluate(size),
    );
  });
  assert.deepEqual(failures, []);
});

test('animated nested document scrolling does not enter a stale-view refresh loop', async (t) => {
  const { source, viewer, root, failures } = await setup(
    t,
    `
    <style>
      body { margin:0; }
      @keyframes enter { from { transform:translateX(-350px); opacity:0 } to { transform:none; opacity:1 } }
      #article { position:absolute; left:400px; top:80px; width:300px; height:350px; overflow:auto; animation:enter 150ms both; }
      #text { height:2500px; }
    </style>
    <section id="article"><div id="text"><button id="switch" onclick="location.hash='next';document.querySelector('#text').dataset.page='next'">Next section</button><h1>Architecture</h1></div></section>
  `,
  );
  await eventually(async () =>
    assert.equal(
      await root
        .locator('#article')
        .evaluate((n) => getComputedStyle(n).transform),
      await source
        .locator('#article')
        .evaluate((n) => getComputedStyle(n).transform),
    ),
  );
  await hoverProjected(root.locator('#article'), {
    position: { x: 100, y: 50 },
    timeout: 3000,
  });
  for (let i = 0; i < 12; i++) {
    await viewer.mouse.wheel(0, 80);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await source.waitForFunction(
    () => document.querySelector('#article')!.scrollTop >= 800,
  );
  await eventually(async () =>
    assert.equal(
      await root.locator('#article').evaluate((n) => n.scrollTop),
      await source.locator('#article').evaluate((n) => n.scrollTop),
    ),
  );
  for (let i = 0; i < 12; i++) {
    await viewer.mouse.wheel(0, -80);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await source.waitForFunction(
    () => document.querySelector('#article')!.scrollTop === 0,
  );
  await clickProjected(root.locator('#switch'));
  await source.waitForFunction(() => location.hash === '#next');
  assert.deepEqual(
    failures,
    [],
    'Ordinary scrolling and document links must not reject input',
  );
  assert.equal(await viewer.locator('#toast').isVisible(), false);
});
