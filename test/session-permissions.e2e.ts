import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  BrowserSession,
  PlaywrightSourceBrowser,
  NativeMediaBridge,
} from '../dist/host/index.js';
import { mediaExecutable } from '../dist/host/media-executable.js';
import type { ServerMessage } from '../src/shared/protocol.js';

async function wait(condition: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(condition(), 'Expected source permission state was not reached');
}

test(
  'page control and directory editing have independent grants while watching permits selection',
  { timeout: 20000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = await BrowserSession.attach(page, {
      authorize: () => false,
    });
    t.after(() => session.close());
    const messages: ServerMessage[] = [];
    const view = await session.observe((message) => messages.push(message), {
      media: false,
    });
    await view.acquireControl(() => true);
    assert.equal(
      messages.findLast((message) => message.type === 'session_access')
        ?.editTabs,
      false,
      'Page input does not imply directory editing',
    );
    let sequence = 0;
    const send = (action: any) =>
      view.receive({
        type: 'command',
        id: ++sequence,
        tab: view.currentState.active,
        epoch: '',
        action,
      });
    await send({ kind: 'tab_new' });
    assert.equal(context.pages().length, 1);
    assert.equal(
      messages.findLast((message) => message.type === 'ack')?.code,
      'not_allowed',
    );
    view.setDirectoryAuthority(() => true);
    await view.releaseControl();
    assert.equal(
      messages.findLast((message) => message.type === 'session_access')
        ?.editTabs,
      true,
      'Releasing page input preserves the separate directory grant',
    );
    await send({ kind: 'tab_new' });
    assert.equal(context.pages().length, 2);
    assert.equal(
      (await session.projection(view.currentState.active)).hasController,
      false,
    );
    const observer = await session.observe(() => {}, { media: false });
    const other = view.currentState.tabs.find(
      (tab) => tab.id !== observer.currentState.active,
    )!;
    await observer.receive({
      type: 'command',
      id: 1,
      tab: observer.currentState.active,
      epoch: '',
      action: { kind: 'tab_select', tab: other.id },
    });
    assert.equal(observer.currentState.active, other.id);
    let authorize!: (allowed: boolean) => void;
    view.setDirectoryAuthority(
      () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    );
    const creating = send({ kind: 'tab_new' });
    await wait(() => Boolean(authorize));
    view.setDirectoryAuthority();
    authorize(true);
    await creating;
    assert.equal(
      context.pages().length,
      2,
      'An asynchronous policy reply cannot resurrect a revoked directory grant',
    );
    await observer.close();
    await view.close();
  },
);

test(
  'host popup admission precedes debugger ownership and preserves the host target identity',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    let popupNotice: { page: typeof page; opener: string } | undefined;
    const owner = new PlaywrightSourceBrowser({
      onPopup: (popup, opener) => {
        popupNotice = { page: popup, opener: opener.id };
      },
    });
    t.after(() => owner.dispose());
    await owner.adopt(page, 'host-opener');
    const popupPromise = page.waitForEvent('popup');
    await page.evaluate(() => window.open('about:blank'));
    const popup = await popupPromise;
    await wait(() => Boolean(popupNotice));
    assert.equal(popupNotice!.page, popup);
    assert.equal(popupNotice!.opener, 'host-opener');
    const source = await owner.adopt(popup, 'host-authorized-popup');
    assert.equal(
      source.id,
      'host-authorized-popup',
      'A popup cannot acquire a native-ID adapter before host admission',
    );
    await assert.rejects(
      owner.adopt(popup, 'different-host-identity'),
      /identity/i,
    );
    assert.equal(await owner.adopt(popup, 'host-authorized-popup'), source);
    await owner.dispose();
    assert.equal(popup.isClosed(), false);
  },
);

test(
  'audio grants name individual sources across observing windows and revoke before handoff',
  { timeout: 25000 },
  async (t) => {
    const browser = await chromium.launch({
      channel: 'chromium',
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const bridge = new NativeMediaBridge(mediaExecutable());
    const owner = new PlaywrightSourceBrowser();
    t.after(async () => {
      await owner.dispose();
      await bridge.close();
      await browser.close();
    });
    const context = await browser.newContext();
    const entries = [];
    for (const id of ['a', 'b']) {
      const page = await context.newPage();
      await page.goto('data:text/html,<audio></audio>');
      await page.evaluate(async () => {
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        await audio.resume();
        const element = document.querySelector('audio')!;
        element.srcObject = destination.stream;
        await element.play();
      });
      entries.push({ page: await owner.adopt(page, id) });
    }
    let collectors = 0;
    const session = await BrowserSession.open(
      {
        list: () => entries,
        subscribe: () => () => {},
        create: async () => {
          throw new Error('not granted');
        },
        close: async () => {},
        move: async () => {},
        pin: async () => {},
        restore: async () => undefined,
      },
      {
        authorize: () => false,
        mediaBridge: {
          close: () => bridge.close(),
          open: (...args) => {
            collectors++;
            return bridge.open(...args);
          },
        },
      },
    );
    t.after(() => session.close());
    const ownership: Record<string, number> = { a: 0, b: 1 };
    const counts: Array<Record<string, number>> = [
      { a: 0, b: 0 },
      { a: 0, b: 0 },
    ];
    const views = [];
    for (const index of [0, 1]) {
      const view = await session.observe(() => {}, {
        initialTab: 'a',
        canHear: (source) => ownership[source.id] === index,
        onMediaFrame: (frame) => {
          if (frame.header.track === 'audio')
            counts[index]![frame.header.target]!++;
        },
      });
      views.push(view);
      await view.receive({
        type: 'command',
        id: 1,
        tab: 'a',
        epoch: '',
        action: { kind: 'tab_select', tab: 'b' },
      });
    }
    await wait(() => counts[0]!.a! > 5 && counts[1]!.b! > 5);
    assert.equal(counts[0]!.b, 0, 'Window one has no audio grant for source b');
    assert.equal(counts[1]!.a, 0, 'Window two has no audio grant for source a');
    const opened = collectors;
    ownership.a = 1;
    const stopped = counts[0]!.a!;
    const background = counts[1]!.b!;
    await views[0]!.refreshGrants();
    await views[1]!.refreshGrants();
    await wait(() => counts[1]!.a! > 5 && counts[1]!.b! > background + 5);
    assert.equal(
      counts[0]!.a,
      stopped,
      'Audio delivery stops as soon as its source grant changes',
    );
    assert.equal(collectors, opened, 'A handoff retains the source collectors');
    await Promise.all(views.map((view) => view.close()));
  },
);
