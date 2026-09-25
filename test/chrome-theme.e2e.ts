import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

for (const dark of [false, true])
  test(`browser chrome preserves the host ${dark ? 'dark' : 'light'} palette across controls`, async (t) => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
    import { mountBrowser } from './src/viewer/index.js';
    import { MediaView } from './src/viewer/media.js';
    import { PROTOCOL_VERSION } from './src/shared/protocol.js';
    const view = mountBrowser(document.querySelector('#host'), {
      connect: () => ({send(){}, subscribe(fn){window.deliver=fn;queueMicrotask(()=>{
        fn({type:'hello',version:PROTOCOL_VERSION,mediaWireVersion:1});
        fn({type:'tabs',state:{active:'one',tabs:[{id:'one',title:'First',url:'https://example.test/'},{id:'two',title:'Second',url:'about:blank'}]}});
        fn({type:'control',target:'one',active:true});
      });return()=>{};}, onDisconnect(){return()=>{};},close(){}}),
      menu:{label:'More actions',actions:[{label:'Choose source',description:'Current profile',run(){},failureMessage:'Unavailable'}]},
      library:{list:async()=>[{title:'Saved page',url:'https://example.test/'}],saveBookmark:async()=>{},removeBookmark:async()=>{},clearHistory:async()=>{}}
    });
    const root = document.querySelector('.floe-browser');
    for(const [name,token] of Object.entries({background:'background',foreground:'foreground',muted:'muted-foreground',line:'border',accent:'primary','accent-foreground':'primary-foreground',surface:'muted',field:'secondary'}))root.style.setProperty('--floe-'+name,'var(--'+token+')');
    root.style.setProperty('--floe-font-family','var(--font-sans)');
    const media=new MediaView(root.querySelector('.toolbar'),()=>null,async()=>true,()=>{});
    media.receive({kind:'state',id:1,stream:'stream',paused:false,time:10,duration:60,volume:1,muted:false,status:'streaming',reason:''},{target:'one',view:'view'});
    window.cleanup=()=>{media.destroy();view.destroy();};
  `,
      },
      bundle: true,
      format: 'iife',
      write: false,
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 960, height: 720 },
    });
    page.setDefaultTimeout(4000);
    await page.route('http://127.0.0.1/theme', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><div id="host" style="height:680px"></div>',
      }),
    );
    await page.goto('http://127.0.0.1/theme');
    await page.addStyleTag({
      content: (await readFile('src/viewer/viewer.css', 'utf8')).replace(
        /^@import[^;]+;/,
        '',
      ),
    });
    await page.addStyleTag({
      content: await readFile('src/viewer/style.css', 'utf8'),
    });
    const palette = dark
      ? {
          background: '#101114',
          foreground: '#f0f1f4',
          muted: '#23252a',
          secondary: '#2a2d33',
          'muted-foreground': '#bbc0ca',
          border: '#4b505a',
          primary: '#e6e9f2',
          'primary-foreground': '#191c24',
        }
      : {
          background: '#ffffff',
          foreground: '#20232a',
          muted: '#edf0f5',
          secondary: '#f0f2f5',
          'muted-foreground': '#535c6b',
          border: '#c5cbd6',
          primary: '#385c99',
          'primary-foreground': '#ffffff',
        };
    await page.addStyleTag({
      content:
        ':root{' +
        Object.entries(palette)
          .map(([key, value]) => `--${key}:${value}`)
          .join(';') +
        ';--font-sans:monospace}',
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.getByRole('tab', { name: 'Second', exact: true }).waitFor();
    const check = async (
      selector: string,
      background: string,
      foreground: string,
    ) => {
      const colors = await page.locator(selector).evaluate(
        (element, { background, foreground }) => {
          const style = getComputedStyle(element);
          const reference = document.createElement('div');
          reference.style.backgroundColor = `var(--${background})`;
          reference.style.color = `var(--${foreground})`;
          document.body.append(reference);
          const expected = getComputedStyle(reference);
          const result = {
            background: style.backgroundColor,
            foreground: style.color,
            expectedBackground: expected.backgroundColor,
            expectedForeground: expected.color,
          };
          reference.remove();
          return result;
        },
        { background, foreground },
      );
      assert.equal(
        colors.background,
        colors.expectedBackground,
        `${selector} background`,
      );
      assert.equal(
        colors.foreground,
        colors.expectedForeground,
        `${selector} foreground`,
      );
      const luminance = (color: string) =>
        color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((n) => n / 255)
          .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
          .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
      const a = luminance(colors.background),
        b = luminance(colors.foreground);
      assert.ok(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
        `${selector} text contrast`,
      );
    };
    await check('.tab-strip', 'muted', 'foreground');
    assert.equal(
      await page
        .locator('.floe-browser')
        .evaluate((e) => getComputedStyle(e).fontFamily),
      'monospace',
    );
    await page
      .getByRole('button', { name: 'Bookmarks and history', exact: true })
      .click();
    await check('.browser-library', 'background', 'foreground');
    await check(
      '.browser-library button[aria-pressed=true]',
      'muted',
      'primary',
    );
    await check('.browser-library input', 'secondary', 'foreground');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await check(
      '.browser-library button[aria-pressed=true]',
      'muted',
      'primary',
    );
    await page
      .getByRole('button', { name: 'Close library', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'More actions', exact: true })
      .click();
    await check('.browser-menu', 'background', 'foreground');
    await page.keyboard.press('Escape');
    for (const [trigger, panel] of [
      ['zoom', '.page-zoom'],
      ['downloads', '.downloads-panel'],
    ]) {
      await page.locator(`[data-floe-ui=${trigger}]`).click();
      await page.locator(panel).waitFor();
      await check(panel, 'background', 'foreground');
      await page.keyboard.press('Escape');
    }
    await page
      .getByRole('button', { name: 'Media controls', exact: true })
      .click();
    await check('.floe-media-panel:popover-open', 'background', 'foreground');
    await check('.floe-media-play', 'muted', 'primary');
    await page.keyboard.press('Escape');
    await page.evaluate(() =>
      (window as any).deliver({
        type: 'state',
        state: {
          id: 'one',
          url: 'https://example.test/',
          title: 'First',
          width: 960,
          height: 600,
          zoom: 1,
          status: 'error',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      }),
    );
    await page.locator('.floe-page-error').waitFor();
    await check('.floe-page-error', 'background', 'foreground');
    await check('.floe-page-error button', 'primary', 'primary-foreground');
    await page.evaluate(() => (window as any).cleanup());
  });
