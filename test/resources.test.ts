import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { CDPSession } from 'playwright';
import { ResourceStore } from '../src/host/resources.js';

const url = 'https://source.test/style.css';
const sheet = { url, type: 'Stylesheet', mimeType: 'text/css' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  t: test.TestContext,
  respond: (method: string, params: any) => any,
) {
  const calls: { method: string; params: any }[] = [];
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method: string, params: any) => {
      calls.push({ method, params });
      return respond(method, params) ?? {};
    },
  });
  const store = new ResourceStore(cdp as unknown as CDPSession);
  t.after(() => store.close());
  const id = (value = url) => store.reference(value, url).split('/').at(-1)!;
  return { cdp, store, id, calls };
}

test('recovers only eligible resources observed in the inspected frame tree', async (t) => {
  const childURL = 'https://child.test/font.woff2';
  const fixture = setup(t, (method, params) => {
    if (method === 'Page.getResourceTree')
      return {
        frameTree: {
          frame: { id: 'main' },
          resources: [
            sheet,
            { ...sheet, url: 'https://source.test/script', type: 'Script' },
            {
              ...sheet,
              url: 'https://source.test/other',
              type: 'Other',
              mimeType: 'text/html',
            },
            {
              ...sheet,
              url: 'https://source.test/svg-script',
              type: 'Script',
              mimeType: 'image/svg+xml',
            },
            { ...sheet, url: 'https://source.test/failed', failed: true },
            { ...sheet, url: 'https://source.test/canceled', canceled: true },
            {
              ...sheet,
              url: 'https://source.test/large',
              contentSize: 8 * 1024 * 1024 + 1,
            },
            { ...sheet, url: 'invalid url' },
          ],
          childFrames: [
            {
              frame: { id: 'child' },
              resources: [
                { url: childURL, type: 'Font', mimeType: 'font/woff2' },
              ],
            },
          ],
        },
      };
    if (method === 'Page.getResourceContent')
      return params.frameId === 'main'
        ? { content: 'body { display: grid }', base64Encoded: false }
        : {
            content: Buffer.from([0, 1, 128, 255]).toString('base64'),
            base64Encoded: true,
          };
  });
  fixture.id('https://unobserved.test/private.css');
  await fixture.store.start();
  assert.equal((await fixture.store.read(fixture.id()))?.type, 'text/css');
  assert.deepEqual(
    (await fixture.store.read(fixture.id(childURL)))?.body,
    Buffer.from([0, 1, 128, 255]),
  );
  assert.deepEqual(
    fixture.calls
      .filter((c) => c.method === 'Page.getResourceContent')
      .map((c) => c.params),
    [
      { frameId: 'main', url },
      { frameId: 'child', url: childURL },
    ],
  );
});

test('resource recovery does not block attachment or overwrite a newer network response', async (t) => {
  const pending = deferred<{ content: string; base64Encoded: boolean }>();
  const { store, cdp, id } = setup(t, (method) => {
    if (method === 'Page.getResourceTree')
      return { frameTree: { frame: { id: 'main' }, resources: [sheet] } };
    if (method === 'Page.getResourceContent') return pending.promise;
    if (method === 'Network.getResponseBody')
      return { body: 'body { color: green }', base64Encoded: false };
  });
  await store.start();
  await tick();
  cdp.emit('Network.responseReceived', {
    requestId: 'new',
    type: 'Stylesheet',
    response: { url, status: 200, mimeType: 'text/css' },
  });
  cdp.emit('Network.loadingFinished', {
    requestId: 'new',
    encodedDataLength: 20,
  });
  assert.equal(
    (await store.read(id()))?.body.toString(),
    'body { color: green }',
  );
  pending.resolve({ content: 'body { color: red }', base64Encoded: false });
  await tick();
  assert.equal(
    (await store.read(id()))?.body.toString(),
    'body { color: green }',
  );
});

test('navigation discards a pending document read and loading completion recovers the current resource', async (t) => {
  const old = deferred<{ content: string; base64Encoded: boolean }>();
  let reads = 0;
  const { store, cdp, id } = setup(t, (method) => {
    if (method === 'Page.getResourceTree')
      return { frameTree: { frame: { id: 'main' }, resources: [sheet] } };
    if (method === 'Page.getResourceContent')
      return ++reads === 1
        ? old.promise
        : { content: 'body { color: green }', base64Encoded: false };
  });
  await store.start();
  await tick();
  let resolved = false;
  const reading = store.read(id()).then((value) => {
    resolved = true;
    return value;
  });
  cdp.emit('Page.frameNavigated', { frame: { id: 'main' } });
  old.resolve({ content: 'body { color: red }', base64Encoded: false });
  await tick();
  assert.equal(
    resolved,
    false,
    'The old document cannot satisfy a current resource request',
  );
  cdp.emit('Page.frameStoppedLoading', { frameId: 'main' });
  assert.equal((await reading)?.body.toString(), 'body { color: green }');
});

test('coalesces load events during recovery and revisits bodies unavailable during attachment', async (t) => {
  const pending = deferred<void>();
  let reads = 0;
  const { store, cdp, id, calls } = setup(t, (method) => {
    if (method === 'Page.getResourceTree')
      return { frameTree: { frame: { id: 'main' }, resources: [sheet] } };
    if (method === 'Page.getResourceContent') {
      if (++reads === 1)
        return pending.promise.then(() => {
          throw new Error('Resource still loading');
        });
      return { content: 'body { display: flex }', base64Encoded: false };
    }
  });
  await store.start();
  await tick();
  for (let i = 0; i < 20; i++)
    cdp.emit('Page.frameStoppedLoading', { frameId: 'main' });
  pending.resolve();
  assert.equal(
    (await store.read(id()))?.body.toString(),
    'body { display: flex }',
  );
  assert.equal(
    calls.filter((c) => c.method === 'Page.getResourceTree').length,
    2,
  );
});

for (const ending of ['close', 'detach'] as const) {
  test(`${ending} discards pending cached resource reads and removes observers`, async (t) => {
    const pending = deferred<{ content: string; base64Encoded: boolean }>();
    const { store, cdp, id } = setup(t, (method) => {
      if (method === 'Page.getResourceTree')
        return { frameTree: { frame: { id: 'main' }, resources: [sheet] } };
      if (method === 'Page.getResourceContent') return pending.promise;
    });
    await store.start();
    await tick();
    let resolved = false;
    const reading = store.read(id()).then((value) => {
      resolved = true;
      return value;
    });
    if (ending === 'close') store.close();
    else cdp.emit('close');
    pending.resolve({ content: 'body { color: red }', base64Encoded: false });
    await tick();
    if (ending === 'detach') assert.equal(resolved, false);
    assert.equal(cdp.eventNames().length, 0);
    store.close();
    assert.equal(await reading, undefined);
  });
}
