import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import {
  CDPSourcePage,
  ResponseDownloads,
  type SourceDownload,
} from '../dist/host/index.js';

test(
  'attachment responses retain source credentials and exact bytes without changing unrelated native downloads',
  { timeout: 15000 },
  async (t) => {
    const bytes = Buffer.from('Source response fixture\n'.repeat(8192));
    let exports = 0;
    const site = http.createServer((request, response) => {
      if (request.url === '/export') {
        exports++;
        assert.equal(request.headers.cookie, 'fixture=authorized');
        assert.equal(request.method, 'POST');
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition':
            "attachment; filename*=UTF-8''source%20%E2%9C%93.txt",
        });
        response.end(bytes);
      } else if (request.url === '/native') {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename=native.txt',
        });
        response.end(bytes);
      } else {
        response.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'fixture=authorized; Path=/; HttpOnly',
        });
        response.end(
          '<!doctype html><form action="/export" method="POST"><button>Export</button></form><button onclick="this.textContent=\'Confirmed\'">Still usable</button><a href="/native">Native download</a>',
        );
      }
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    t.after(() => {
      site.closeAllConnections();
      site.close();
    });
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    const transport = await context.newCDPSession(page);
    const files: SourceDownload[] = [];
    let completed!: () => void;
    const ready = new Promise<void>((resolve) => (completed = resolve));
    const downloads = new ResponseDownloads((file) => {
      files.push(file);
      file.subscribe(() => {
        if (file.state.status !== 'receiving') completed();
      });
    });
    t.after(() => downloads.close());
    transport.on('Fetch.requestPaused', (event) => {
      if (!downloads.handle(transport, event))
        void transport.send('Fetch.continueRequest', {
          requestId: event.requestId,
        });
    });
    await transport.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
      ],
    });
    await page
      .getByRole('button', { name: 'Export', exact: true })
      .click({ noWaitAfter: true });
    await ready;
    assert.equal(files[0]!.state.status, 'complete');
    assert.equal(files[0]!.state.filename, 'source ✓.txt');
    assert.equal(
      exports,
      1,
      'the original POST response is consumed without a second request',
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of await files[0]!.open(
      new AbortController().signal,
    ))
      chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    await page.getByRole('button', { name: 'Still usable' }).click();
    await page.getByRole('button', { name: 'Confirmed' }).waitFor();
    const unrelated = await context.newPage();
    await unrelated.goto(origin);
    const native = unrelated.waitForEvent('download');
    await unrelated.getByRole('link', { name: 'Native download' }).click();
    assert.equal((await native).suggestedFilename(), 'native.txt');
    assert.equal(
      files.length,
      1,
      'unrelated personal tabs keep their native downloads',
    );
    await downloads.close();
    await assert.rejects(files[0]!.open(new AbortController().signal));
  },
);

test(
  'canceling a source response download closes its stream and leaves the page usable',
  { timeout: 15000 },
  async (t) => {
    const site = http.createServer((request, response) => {
      if (request.url === '/slow') {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename=slow.bin',
        });
        response.write(Buffer.alloc(32768));
        const timer = setInterval(
          () => response.write(Buffer.alloc(32768)),
          200,
        );
        response.on('close', () => clearInterval(timer));
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(
          '<!doctype html><a href="/slow">Download</a><button onclick="this.textContent=\'Confirmed\'">Continue</button>',
        );
      }
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    t.after(() => {
      site.closeAllConnections();
      site.close();
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${(site.address() as { port: number }).port}`,
    );
    const transport = await page.context().newCDPSession(page);
    let admit!: (file: SourceDownload) => void;
    const admitted = new Promise<SourceDownload>(
      (resolve) => (admit = resolve),
    );
    const downloads = new ResponseDownloads(admit);
    t.after(() => downloads.close());
    transport.on('Fetch.requestPaused', (event) => {
      if (!downloads.handle(transport, event))
        void transport.send('Fetch.continueRequest', {
          requestId: event.requestId,
        });
    });
    await transport.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
      ],
    });
    await page
      .getByRole('link', { name: 'Download' })
      .click({ noWaitAfter: true });
    const file = await admitted;
    await file.cancel();
    assert.equal(file.state.status, 'canceled');
    await assert.rejects(file.open(new AbortController().signal));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Confirmed' }).waitFor();
  },
);

test(
  'binary responses without attachment headers retain the original POST and browser filename',
  { timeout: 15000 },
  async (t) => {
    let requests = 0;
    const bytes = Buffer.from('Original binary response');
    const site = http.createServer((request, response) => {
      if (request.url === '/source%20report.bin') {
        requests++;
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.cookie, 'fixture=authorized');
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end(bytes);
      } else {
        response.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'fixture=authorized; Path=/; HttpOnly',
        });
        response.end(
          '<!doctype html><form action="/source%20report.bin" method="POST"><button>Export binary</button></form>',
        );
      }
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    t.after(() => {
      site.closeAllConnections();
      site.close();
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${(site.address() as { port: number }).port}`,
    );
    const transport = await page.context().newCDPSession(page);
    let admit!: (file: SourceDownload | undefined) => void;
    const admitted = new Promise<SourceDownload | undefined>(
      (resolve) => (admit = resolve),
    );
    const downloads = new ResponseDownloads(admit);
    t.after(() => downloads.close());
    page.on('download', () => admit(undefined));
    transport.on('Fetch.requestPaused', (event) => {
      if (!downloads.handle(transport, event))
        void transport.send('Fetch.continueRequest', {
          requestId: event.requestId,
        });
    });
    await transport.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
      ],
    });
    await page.getByRole('button').click({ noWaitAfter: true });
    const file = await admitted;
    assert.ok(
      file,
      'the source adapter must export the original binary response',
    );
    await new Promise<void>((resolve) => {
      const changed = () => {
        if (file.state.status !== 'receiving') {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = file.subscribe(changed);
      changed();
    });
    assert.equal(file.state.status, 'complete');
    assert.equal(file.state.filename, 'source report.bin');
    const chunks: Uint8Array[] = [];
    for await (const chunk of await file.open(new AbortController().signal))
      chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(requests, 1);
  },
);

test(
  'an observed source Blob remains exportable after immediate object URL revocation',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(
      "data:text/html,<button onclick=\"const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['original blob bytes']));a.download='source-blob.txt';a.click();window.URL.revokeObjectURL(a.href)\">Export Blob</button>",
    );
    const transport = await page.context().newCDPSession(page);
    const source = await CDPSourcePage.attach({
      id: 'blob-source',
      transport,
      downloads: true,
    });
    t.after(() => source.dispose());
    let admit!: (file: SourceDownload | undefined) => void;
    const admitted = new Promise<SourceDownload | undefined>(
      (resolve) => (admit = resolve),
    );
    const downloads = new ResponseDownloads(admit);
    t.after(() => downloads.close());
    await downloads.observe(source, () => admit(undefined));
    await page.getByRole('button').click();
    const file = await admitted;
    assert.ok(
      file,
      'the source Blob download must retain its immutable original bytes',
    );
    await new Promise<void>((resolve) => {
      const changed = () => {
        if (file.state.status !== 'receiving') {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = file.subscribe(changed);
      changed();
    });
    assert.equal(file.state.status, 'complete');
    assert.equal(file.state.filename, 'source-blob.txt');
    const chunks: Uint8Array[] = [];
    for await (const chunk of await file.open(new AbortController().signal))
      chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'original blob bytes');
    await downloads.close();
    await assert.rejects(file.open(new AbortController().signal));
  },
);
