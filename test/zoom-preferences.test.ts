import assert from 'node:assert/strict';
import test from 'node:test';
import { OriginZoom } from '../src/viewer/zoom-preferences.js';
import type { BrowserState, Action } from '../src/shared/protocol.js';

const state = (url: string, zoom = 1, id = 'source') =>
  ({ id, url, zoom }) as BrowserState;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
test('zoom restoration follows control and origin; stale reads lose to navigation and explicit input', async () => {
  const reads: Array<{
    origin: string;
    signal: AbortSignal;
    resolve(value: number): void;
  }> = [];
  const actions: Action[] = [],
    saved: unknown[] = [];
  const zoom = new OriginZoom(
    {
      load: (origin, signal) =>
        new Promise((resolve) => reads.push({ origin, signal, resolve })),
      save: async (origin, factor) => {
        saved.push([origin, factor]);
      },
    },
    async (action) => {
      actions.push(action);
      return true;
    },
    () => assert.fail('preference failure'),
  );
  zoom.state(state('https://one.test/a'));
  assert.equal(reads.length, 0);
  zoom.enable(true);
  assert.equal(reads[0]!.origin, 'https://one.test');
  zoom.state(state('https://two.test/a'));
  assert.equal(reads[0]!.signal.aborted, true);
  reads[0]!.resolve(2);
  await flush();
  assert.equal(actions.length, 0);
  reads[1]!.resolve(1.5);
  await flush();
  assert.deepEqual(actions, [{ kind: 'zoom', factor: 1.5 }]);
  zoom.state(state('https://two.test/b', 1.5));
  assert.equal(reads.length, 2);
  zoom.state(state('https://three.test/'));
  await zoom.change({ kind: 'zoom', factor: 1.25 });
  assert.equal(reads[2]!.signal.aborted, true);
  reads[2]!.resolve(2);
  await flush();
  assert.deepEqual(saved, [['https://three.test', 1.25]]);
  assert.equal(actions.length, 2);
  zoom.enable(false);
  zoom.state(state('https://four.test/'));
  assert.equal(reads.length, 3);
  zoom.enable(true);
  zoom.destroy();
  reads[3]!.resolve(3);
  await flush();
  assert.equal(actions.length, 2);
});
test('rejected zoom is never saved or retried and credential URLs have no preference', async () => {
  let reads = 0,
    writes = 0,
    effects = 0;
  const zoom = new OriginZoom(
    {
      load: async () => {
        reads++;
        return 1;
      },
      save: async () => {
        writes++;
      },
    },
    async () => {
      effects++;
      return false;
    },
    () => {},
  );
  zoom.enable(true);
  zoom.state(state('https://user:secret@site.test/'));
  await flush();
  assert.equal(reads, 0);
  zoom.state(state('https://site.test/'));
  await flush();
  await zoom.change({ kind: 'zoom', factor: 2 });
  assert.equal(effects, 1);
  assert.equal(writes, 0);
  zoom.destroy();
});
