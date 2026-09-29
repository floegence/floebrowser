import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSession } from '../src/host/session.js';
import type { SourceDirectory } from '../src/host/directory.js';
import type { Action, ServerMessage } from '../src/shared/protocol.js';

test('selection admission acknowledges intent without waiting for a source and accepts newer explicit targets', async () => {
  const pending: Array<(reason: Error) => void> = [];
  const removed: string[] = [];
  const directory: SourceDirectory = {
    list: () => ['a', 'b', 'c'].map((id) => ({ id, url: 'about:blank' })),
    downloads: () => [],
    subscribe: () => () => {},
    resolve: async (id) => {
      if (id === 'a') throw new Error('Initial source unavailable');
      return new Promise((_, reject) => pending.push(reject));
    },
    create: async () => 'c',
    close: async (id) => {
      removed.push(id);
    },
    move: async () => {},
    pin: async () => {},
    restore: async () => undefined,
  };
  const session = await BrowserSession.open(directory, {
    authorize: () => true,
  });
  const messages: ServerMessage[] = [];
  const view = await session.observe((message) => messages.push(message));
  view.setDirectoryAuthority(() => true);
  try {
    const send = (id: number, action: Action) =>
      view.receive({ type: 'command', id, tab: 'a', epoch: '', action });
    const first = send(1, { kind: 'tab_select', tab: 'b' });
    await first;
    const latest = send(2, { kind: 'tab_select', tab: 'c' });
    const close = send(3, { kind: 'tab_close', tab: 'b' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      view.currentState.active,
      'c',
      'Latest explicit selection must supersede unresolved admission',
    );
    assert.deepEqual(
      removed,
      ['b'],
      'Closing an explicit target is independent of another target admission',
    );
    assert.deepEqual(
      messages
        .filter((m) => m.type === 'ack')
        .sort((a, b) => a.id - b.id)
        .map((m) => [m.id, m.ok]),
      [
        [1, true],
        [2, true],
        [3, true],
      ],
    );
    await Promise.all([first, latest, close]);
  } finally {
    pending.forEach((reject) => reject(new Error('Fixture finished')));
    await view.close();
    await session.close();
  }
});

test('late selection authorization cannot block or replace newer intent', async () => {
  const directory: SourceDirectory = {
    list: () => ['a', 'b', 'c'].map((id) => ({ id, url: 'about:blank' })),
    downloads: () => [],
    subscribe: () => () => {},
    resolve: async () => {
      throw new Error('Fixture source unavailable');
    },
    create: async () => 'c',
    close: async () => {},
    move: async () => {},
    pin: async () => {},
    restore: async () => undefined,
  };
  const session = await BrowserSession.open(directory, {
    authorize: () => true,
  });
  const messages: ServerMessage[] = [];
  const view = await session.observe((message) => messages.push(message));
  let release!: (value: boolean) => void;
  const permission = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  view.setDirectoryAuthority((action) =>
    action.kind === 'tab_select' && action.tab === 'b' ? permission : true,
  );
  const send = (id: number, tab: string) =>
    view.receive({
      type: 'command',
      id,
      tab: 'a',
      epoch: '',
      action: { kind: 'tab_select', tab },
    });
  const old = send(1, 'b');
  const latest = send(2, 'c');
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      view.currentState.active,
      'c',
      'A pending permission result cannot hold another authorized selection',
    );
    assert.equal(
      messages.find((m) => m.type === 'ack' && m.id === 2)?.ok,
      true,
    );
    release(true);
    await Promise.all([old, latest]);
    assert.equal(
      view.currentState.active,
      'c',
      'A late result cannot select the superseded target',
    );
    assert.equal(
      messages.find((m) => m.type === 'ack' && m.id === 1)?.code,
      'stale_view',
    );
  } finally {
    release(false);
    await Promise.allSettled([old, latest]);
    await view.close();
    await session.close();
  }
});

test('native effects retain receive order without waiting for source admission or repeating a request', async () => {
  const effects: string[] = [];
  let release!: () => void;
  const firstCreated = new Promise<void>((resolve) => {
    release = resolve;
  });
  let created = 0;
  const directory: SourceDirectory = {
    list: () => ['a', 'b', 'c', 'd'].map((id) => ({ id, url: 'about:blank' })),
    downloads: () => [],
    subscribe: () => () => {},
    resolve: async () => {
      throw new Error('Fixture source unavailable');
    },
    create: async () => {
      const id = ++created;
      effects.push(`create:${id}:start`);
      if (id === 1) await firstCreated;
      effects.push(`create:${id}:end`);
      return id === 1 ? 'c' : 'd';
    },
    close: async (id) => {
      effects.push(`close:${id}`);
    },
    move: async () => {},
    pin: async () => {},
    restore: async () => undefined,
  };
  const session = await BrowserSession.open(directory, {
    authorize: () => true,
  });
  const messages: ServerMessage[] = [];
  const view = await session.observe((message) => messages.push(message));
  view.setDirectoryAuthority(() => true);
  const send = (id: number, action: Action) =>
    view.receive({ type: 'command', id, tab: 'a', epoch: '', action });
  const first = send(1, { kind: 'tab_new' });
  const second = send(2, { kind: 'tab_new' });
  const close = send(3, { kind: 'tab_close', tab: 'b' });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(effects, ['create:1:start']);
    release();
    await Promise.all([first, second, close]);
    assert.deepEqual(effects, [
      'create:1:start',
      'create:1:end',
      'create:2:start',
      'create:2:end',
      'close:b',
    ]);
    assert.equal(
      view.currentState.active,
      'd',
      'Closing another tab cannot erase the newest creation intent',
    );
    assert.deepEqual(
      messages.filter((m) => m.type === 'ack').map((m) => m.ok),
      [true, true, true],
    );
    await send(3, { kind: 'tab_close', tab: 'b' });
    assert.equal(
      effects.length,
      5,
      'A duplicated command ID cannot repeat the close',
    );
    assert.equal(
      messages.findLast((m) => m.type === 'ack')?.code,
      'stale_view',
    );
  } finally {
    release();
    await Promise.allSettled([first, second, close]);
    await view.close();
    await session.close();
  }
});
