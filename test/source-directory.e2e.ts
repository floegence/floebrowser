import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { BrowserSession, PlaywrightSourceBrowser } from '../dist/host/index.js';
import type { SourceDirectory, SourceTab } from '../src/host/directory.js';
import type { ServerMessage } from '../src/shared/protocol.js';

test(
  'host directory grants remain authoritative and unlisted popups never gain projection or control',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const first = await context.newPage(),
      second = await context.newPage(),
      unrelated = await context.newPage();
    const owner = new PlaywrightSourceBrowser();
    const a = await owner.adopt(first, 'authorized-a'),
      b = await owner.adopt(second, 'authorized-b');
    let entries: SourceTab[] = [
      { id: a.id, url: a.url() },
      { id: b.id, url: b.url() },
    ];
    const listeners = new Set<(change: { activate?: string }) => void>();
    let closed = '';
    const directory: SourceDirectory = {
      downloads: () => [],
      list: () => entries,
      resolve: async (id) => {
        const page = [a, b].find((page) => page.id === id);
        if (!page) throw new Error('Unknown source');
        return page;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      create: async () => {
        throw new Error('Host forbids creation');
      },
      close: async (id) => {
        closed = id;
        entries = entries.filter((entry) => entry.id !== id);
        for (const listener of listeners) listener({});
      },
      move: async (id, before) => {
        const item = entries.find((entry) => entry.id === id)!;
        entries = entries.filter((entry) => entry !== item);
        entries.splice(
          before === null
            ? entries.length
            : entries.findIndex((entry) => entry.id === before),
          0,
          item,
        );
        for (const listener of listeners) listener({});
      },
      pin: async (id, pinned) => {
        entries = entries.map((entry) =>
          entry.id === id ? { ...entry, pinned } : entry,
        );
        for (const listener of listeners) listener({});
      },
      restore: async () => {
        throw new Error('Host has no closed tabs');
      },
    };
    const session = await BrowserSession.open(directory, {
      authorize: () => true,
    });
    const messages: ServerMessage[] = [];
    const connection = await session.connect((message) =>
      messages.push(message),
    );
    t.after(async () => {
      await session.close();
      await owner.dispose();
      await browser.close();
    });
    assert.deepEqual(
      session.currentState.tabs.map((tab) => tab.id),
      ['authorized-a', 'authorized-b'],
    );
    const popup = await context.newPage();
    const ungranted = await owner.adopt(popup, 'ungranted-popup');
    a.emit('popup', ungranted);
    await first.evaluate(() => 0);
    assert.deepEqual(
      session.currentState.tabs.map((tab) => tab.id),
      ['authorized-a', 'authorized-b'],
    );
    let id = 0;
    const send = (action: any) =>
      connection.receive({
        type: 'command',
        id: ++id,
        tab: session.currentState.active,
        epoch: '',
        action,
      });
    await send({ kind: 'tab_select', tab: 'ungranted-popup' });
    assert.equal(
      messages.findLast((m) => m.type === 'ack')?.code,
      'stale_view',
    );
    await send({ kind: 'tab_pin', tab: a.id, pinned: true });
    assert.equal(session.currentState.tabs[0]!.pinned, true);
    await send({ kind: 'tab_move', tab: b.id, before: a.id });
    assert.deepEqual(
      session.currentState.tabs.map((tab) => tab.id),
      ['authorized-b', 'authorized-a'],
    );
    await send({ kind: 'tab_close', tab: b.id });
    assert.equal(closed, b.id);
    assert.equal(
      second.isClosed(),
      false,
      'Only the host decides whether removing a tab closes its source',
    );
    assert.equal(unrelated.isClosed(), false);
    await connection.close();
    await session.close();
    assert.equal(listeners.size, 0);
    assert.equal(first.isClosed(), false);
  },
);

test(
  'lazy profile resolution shares attachment, preserves focus and isolates selection failures',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const owner = new PlaywrightSourceBrowser();
    const a = await owner.adopt(await context.newPage(), 'a');
    const b = await owner.adopt(await context.newPage(), 'b');
    let focus = 0;
    a.bringToFront = b.bringToFront = async () => {
      focus++;
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const directory: SourceDirectory = {
      downloads: () => [],
      list: () => [
        { id: 'a', url: 'about:blank' },
        { id: 'b', url: 'about:blank' },
        {
          id: 'internal',
          url: 'chrome://settings',
          availability: 'unsupported',
        },
      ],
      subscribe: () => () => {},
      resolve: async (id) => {
        calls.push(id);
        if (id === 'b') await held;
        return id === 'a' ? a : b;
      },
      create: async () => {
        throw new Error('Not used');
      },
      close: async () => {},
      move: async () => {},
      pin: async () => {},
      restore: async () => undefined,
    };
    const session = await BrowserSession.open(directory, {
      authorize: () => true,
    });
    t.after(async () => {
      release();
      await session.close();
      await owner.dispose();
    });
    assert.deepEqual(calls, []);
    const first = await session.observe(() => {});
    const second = await session.observe(() => {});
    assert.deepEqual(calls, ['a']);
    await first.acquireControl(
      () => true,
      () => true,
    );
    assert.equal(
      focus,
      0,
      'Control never brings a native tab or window forward',
    );
    first.setDirectoryAuthority(() => true);
    const delayed = first.receive({
      type: 'command',
      id: 1,
      tab: 'a',
      epoch: '',
      action: { kind: 'tab_select', tab: 'b' },
    });
    while (first.currentState.active !== 'b')
      await new Promise((resolve) => setImmediate(resolve));
    const shared = second.select('b');
    await first.receive({
      type: 'command',
      id: 2,
      tab: 'b',
      epoch: '',
      action: { kind: 'tab_select', tab: 'a' },
    });
    release();
    await Promise.all([delayed, shared]);
    assert.deepEqual(
      calls,
      ['a', 'b'],
      'Concurrent viewers share one lazy source owner',
    );
    assert.equal(
      first.currentState.active,
      'a',
      'A late resolver cannot override the latest selection',
    );
    assert.equal(second.currentState.active, 'b');
    await first.select('internal');
    assert.deepEqual(
      calls,
      ['a', 'b'],
      'Internal pages remain visible without debugger attachment',
    );
    await first.close();
    await second.close();
  },
);
