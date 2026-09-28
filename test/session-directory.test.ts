import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSession } from '../src/host/session.js';
import type { SourceDirectory, SourceTab } from '../src/host/directory.js';
import type { ServerMessage } from '../src/shared/protocol.js';

test('metadata-only directories stay usable when the selected projection fails', async () => {
  let entries: SourceTab[] = [
    { id: 'native-a', title: 'Existing tab', url: 'https://example.test/' },
  ];
  let changed = () => {};
  let resolved = 0;
  const directory: SourceDirectory = {
    downloads: () => [],
    list: () => entries,
    subscribe: (listener) => {
      changed = () => listener({});
      return () => {};
    },
    resolve: async () => {
      resolved++;
      throw new Error('Debugger detached');
    },
    create: async () => {
      entries = [...entries, { id: 'native-b', url: 'about:blank' }];
      changed();
      return 'native-b';
    },
    close: async (id) => {
      entries = entries.filter((entry) => entry.id !== id);
      changed();
    },
    move: async () => {},
    pin: async () => {},
    restore: async () => undefined,
  };
  const session = await BrowserSession.open(directory, {
    authorize: () => true,
  });
  try {
    assert.equal(resolved, 0, 'Listing must not attach any page');
    const messages: ServerMessage[] = [];
    const view = await session.observe((message) => messages.push(message));
    view.setDirectoryAuthority(() => true);
    assert.equal(resolved, 1);
    assert.equal(view.currentState.active, 'native-a');
    assert.equal(view.currentState.tabs[0]?.title, 'Existing tab');
    assert(
      messages.some(
        (message) =>
          message.type === 'projection' && message.status === 'unavailable',
      ),
    );
    await view.receive({
      type: 'command',
      id: 1,
      tab: 'native-a',
      epoch: '',
      action: { kind: 'tab_new' },
    });
    assert.equal(
      view.currentState.active,
      'native-b',
      'Creation retains real identity even when projection fails',
    );
    assert.equal(view.currentState.tabs.length, 2);
    await view.receive({
      type: 'command',
      id: 2,
      tab: 'native-b',
      epoch: '',
      action: { kind: 'tab_retry', tab: 'native-b' },
    });
    assert.equal(
      view.currentState.tabs.length,
      2,
      'Display retry never creates another tab',
    );
    await directory.close('native-a');
    await directory.close('native-b');
    await view.refreshGrants();
    assert.deepEqual(view.currentState, { active: '', tabs: [] });
    await view.receive({
      type: 'command',
      id: 3,
      tab: '',
      epoch: '',
      action: { kind: 'tab_new' },
    });
    assert.equal(
      view.currentState.active,
      'native-b',
      'An empty workspace can create its next native tab',
    );
    await view.close();
  } finally {
    await session.close();
  }
});
