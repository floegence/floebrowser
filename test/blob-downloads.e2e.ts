import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { chromium } from 'playwright';
import {
  PlaywrightSourceBrowser,
  ResponseDownloads,
  type SourceDownload,
} from '../dist/host/index.js';

async function read(file: SourceDownload): Promise<string> {
  if (file.state.status === 'receiving') {
    await new Promise<void>((resolve) => {
      const unsubscribe = file.subscribe(() => {
        if (file.state.status !== 'receiving') {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  assert.equal(file.state.status, 'complete');
  const chunks: Uint8Array[] = [];
  for await (const chunk of await file.open(new AbortController().signal))
    chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test(
  'Blob downloads remain source scoped, repeatable and disposable across frame navigation',
  { timeout: 15000 },
  async (t) => {
    const site = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html><script>
      window.nativeCreate = URL.createObjectURL;
      window.nativeRevoke = URL.revokeObjectURL;
      window.early = URL.createObjectURL(new Blob(['before observation']));
      window.exportURL = (url) => { const a = document.createElement('a'); a.href=url; a.download='blob.txt'; a.click(); };
      </script><button onclick="window.saved ||= window.URL.createObjectURL(new Blob([location.pathname + ' immutable bytes']));exportURL(window.saved)">Export</button>`);
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    t.after(() => {
      site.closeAllConnections();
      site.close();
    });
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    const browser = await chromium.launch({ args: ['--site-per-process'] });
    t.after(() => browser.close());
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(origin);
    const owner = new PlaywrightSourceBrowser({ nativeDownloads: false });
    const source = await owner.adopt(page, 'blob-source');
    t.after(() => owner.dispose());
    const events = new EventEmitter();
    const files: SourceDownload[] = [];
    const downloads = new ResponseDownloads((file) => {
      files.push(file);
      events.emit('file', file);
    });
    t.after(() => downloads.close());
    await downloads.observe(source, () => events.emit('unavailable'));

    const earlyUnavailable = once(events, 'unavailable');
    await page.evaluate(() => (window as any).exportURL((window as any).early));
    await earlyUnavailable;
    assert.equal(
      files.length,
      0,
      'pre-observation bytes are never guessed or refetched',
    );

    const unrelated = await context.newPage();
    await unrelated.goto(origin + '/unrelated');
    const native = unrelated.waitForEvent('download');
    await unrelated.getByRole('button').click();
    assert.equal((await native).suggestedFilename(), 'blob.txt');
    assert.equal(
      await unrelated.evaluate(
        () => URL.createObjectURL === (window as any).nativeCreate,
      ),
      true,
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      const admitted = once(events, 'file');
      await page.getByRole('button').click();
      assert.equal(await read((await admitted)[0]), '/ immutable bytes');
    }
    assert.equal(
      files.length,
      2,
      'unrelated native exports never enter the source catalog',
    );

    await page.evaluate((url) => {
      const frame = document.createElement('iframe');
      frame.src = url;
      document.body.append(frame);
    }, origin + '/child');
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button').waitFor();
    const child = once(events, 'file');
    await frame.getByRole('button').click();
    assert.equal(await read((await child)[0]), '/child immutable bytes');
    for (const [address, name] of [
      [origin, '/replacement'],
      [origin.replace('127.0.0.1', 'localhost'), '/cross-site'],
      [origin, '/returned'],
    ]) {
      const navigation = page.waitForEvent('framenavigated', {
        predicate: (current) => current.url() === address + name,
      });
      await page.evaluate((url) => {
        document.querySelector('iframe')!.src = url;
      }, address! + name!);
      await navigation;
      await frame.getByRole('button').waitFor();
      const replacement = once(events, 'file');
      await frame.getByRole('button').click();
      assert.equal(
        await read((await replacement)[0]),
        name + ' immutable bytes',
      );
    }

    const largeUnavailable = once(events, 'unavailable');
    await page.evaluate(() =>
      (window as any).exportURL(
        URL.createObjectURL(new Blob([new Uint8Array(32 * 1024 * 1024 + 1)])),
      ),
    );
    await largeUnavailable;
    await downloads.close();
    assert.equal(
      await page.evaluate(
        () =>
          URL.createObjectURL === (window as any).nativeCreate &&
          URL.revokeObjectURL === (window as any).nativeRevoke,
      ),
      true,
    );
    assert.equal(
      await page
        .frames()[1]!
        .evaluate(() => URL.createObjectURL === (window as any).nativeCreate),
      true,
    );
    assert.equal(
      await page.evaluate(async () =>
        (await fetch((window as any).saved)).text(),
      ),
      '/ immutable bytes',
      'disposal preserves the website-owned object URL',
    );
    for (const file of files)
      await assert.rejects(file.open(new AbortController().signal));
  },
);
