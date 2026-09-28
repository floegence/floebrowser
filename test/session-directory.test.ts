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

test('grant refresh drains revoked access without waiting for lazy page resolution', async () => {
  let entries: SourceTab[] = [{ id: 'initial', url: 'about:blank' }];
  let changed = () => {};
  let rejectPending: (error: Error) => void = () => {};
  const directory: SourceDirectory = {
    list: () => entries,
    downloads: () => [],
    subscribe: (listener) => {
      changed = () => listener({});
      return () => {};
    },
    resolve: async (id) => {
      if (id === 'initial') throw new Error('Initial projection unavailable');
      return new Promise((_, reject) => {
        rejectPending = reject;
      });
    },
    create: async () => '',
    close: async () => {},
    move: async () => {},
    pin: async () => {},
    restore: async () => undefined,
  };
  const session = await BrowserSession.open(directory, {
    authorize: () => false,
  });
  try {
    const view = await session.observe(() => {});
    entries = [{ id: 'next', url: 'about:blank' }];
    changed();
    let refreshed = false;
    const refresh = view.refreshGrants().then(() => {
      refreshed = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        refreshed,
        true,
        'Directory authorization cannot wait for a host resolver that needs the directory lock',
      );
      assert.equal(view.currentState.active, 'next');
    } finally {
      rejectPending(new Error('Fixture complete'));
      await refresh;
    }
    await view.close();
  } finally {
    await session.close();
  }
});
