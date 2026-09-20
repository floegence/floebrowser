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
  await root.locator('#content').hover({ position: { x: 100, y: 100 } });
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
