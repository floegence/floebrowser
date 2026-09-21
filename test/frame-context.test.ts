import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { FrameBridge } from '../src/host/frames.js';
import type {
  SourcePage,
  SourceFrame,
  SourceTransport,
} from '../src/host/source.js';
import type { ResourceStore } from '../src/host/resources.js';

test('a child context arriving after navigation receives its recorder without another navigation or debugger attachment', async () => {
  const transport = {} as SourceTransport;
  const main = { transport } as SourceFrame;
  const contexts: number[] = [];
  const child = {
    transport,
    contextID: 0,
    async evaluate(script: unknown) {
      if (!this.contextID)
        throw new Error('Source frame has no execution context');
      if (script === 'recorder') contexts.push(this.contextID);
    },
  };
  const page = Object.assign(new EventEmitter(), {
    transport,
    sessions: () => [transport],
    mainFrame: () => main,
    frames: () => [main, child],
  });
  const bridge = new FrameBridge(
    page as SourcePage,
    'recorder',
    'key',
    {} as ResourceStore,
  );
  await bridge.start();
  page.emit('framenavigated', child);
  child.contextID = 7;
  page.emit('framecontext', child);
  assert.deepEqual(
    contexts,
    [7],
    'Recorder installation must follow the new default execution context',
  );
  child.contextID = 0;
  page.emit('framenavigated', child);
  child.contextID = 11;
  page.emit('framecontext', child);
  assert.deepEqual(
    contexts,
    [7, 11],
    'Reusing a source frame cannot reuse its previous document context',
  );
  await bridge.close();
  child.contextID = 12;
  page.emit('framecontext', child);
  assert.deepEqual(
    contexts,
    [7, 11],
    'A retired projection must stop installing recorders',
  );
});
