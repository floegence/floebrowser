import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, firefox, webkit, type Page } from 'playwright';
import { createProjectionServer } from '../dist/host/server.js';

// An ordinary draggable control. No external challenge or verification service.
const fixture = `<!doctype html><style>
body{margin:0}#track{position:absolute;left:80px;top:100px;width:600px;height:80px;background:#ddd}
#thumb{position:absolute;width:180px;height:80px;background:teal;touch-action:none;user-select:none}
</style><div id="track"><div id="thumb"></div></div><output id="value">0</output><script>
window.samples=[];window.releases=0;let start=0,position=0,held=false;
thumb.onpointerdown=e=>{if(!e.isTrusted)return;held=true;start=e.clientX-position;thumb.setPointerCapture(e.pointerId)};
thumb.onpointermove=e=>{if(!held)return;position=Math.max(0,Math.min(420,e.clientX-start));thumb.style.transform='translateX('+position+'px)';value.textContent=position; samples.push({x:e.clientX,position,trusted:e.isTrusted,buttons:e.buttons})};
thumb.onpointerup=e=>{held=false};thumb.onlostpointercapture=()=>held=false;addEventListener('mouseup',()=>releases++);
</script>`;

async function observe(viewer: Page) {
  await viewer.addInitScript(() => {
    (window as any).__name = (v: unknown) => v;
    const state = ((window as any).dragTest = {
      hold: false,
      events: [] as (() => void)[],
      commands: [] as any[],
      acks: [] as any[],
      flush() {
        state.hold = false;
        for (const run of state.events.splice(0)) run();
      },
    });
    const Socket = WebSocket;
    (window as any).WebSocket = class extends Socket {
      send(data: string) {
        const message = JSON.parse(data);
        if (message.type === 'command') state.commands.push(message);
        super.send(data);
      }
      addEventListener(type: string, listener: any, options?: any) {
        if (type !== 'message')
          return super.addEventListener(type, listener, options);
        super.addEventListener(
          type,
          (event: MessageEvent) => {
            const message = JSON.parse(event.data);
            if (message.type === 'ack') state.acks.push(message);
            if (message.type === 'events' && state.hold)
              state.events.push(() => listener(event));
            else listener(event);
          },
          options,
        );
      }
    };
  });
}
async function settled(viewer: Page) {
  await viewer.waitForFunction(() => {
    const s = (window as any).dragTest;
    return (
      s.commands.length &&
      s.commands.every((c: any) => s.acks.some((a: any) => a.id === c.id))
    );
  });
}

test(
  'a held pointer follows viewport coordinates while the source thumb moves ahead of its projection',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    const source = await browser.newPage();
    await source.goto('data:text/html,' + encodeURIComponent(fixture));
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(3000);
    await observe(viewer);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await settled(viewer);
    const thumb = viewer.frameLocator('#viewport iframe').locator('#thumb');
    const box = (await thumb.boundingBox())!;
    await viewer.mouse.move(box.x + 20, box.y + 40);
    await settled(viewer);
    await viewer.mouse.down();
    await settled(viewer);
    await viewer.evaluate(() => ((window as any).dragTest.hold = true));
    for (const dx of [20, 40, 60, 80, 100, 120, 140, 160, 180, 200]) {
      await viewer.mouse.move(box.x + 20 + dx, box.y + 40);
      await settled(viewer);
    }
    const result = await source.evaluate(() => ({
      samples: (window as any).samples,
      releases: (window as any).releases,
      position: Number(document.querySelector('#value')!.textContent),
    }));
    t.diagnostic(JSON.stringify(result));
    assert.equal(
      result.releases,
      0,
      'No mouseup may be synthesized during a held drag',
    );
    assert.equal(
      result.position,
      200,
      'A moving thumb must not move the input coordinate system',
    );
    assert.deepEqual(
      result.samples.map((s: any) => s.position),
      [20, 40, 60, 80, 100, 120, 140, 160, 180, 200],
    );
    assert.ok(result.samples.every((s: any) => s.trusted && s.buttons === 1));
    await viewer.mouse.up();
    await settled(viewer);
    await viewer.evaluate(() => (window as any).dragTest.flush());
    await viewer.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>('#viewport iframe')
          ?.contentDocument?.querySelector('#value')?.textContent === '200',
    );
    assert.equal(await source.evaluate(() => (window as any).releases), 1);
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);

test(
  'a slow source keeps only the latest unsent drag sample and releases at the final position',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    const source = await browser.newPage();
    await source.goto('data:text/html,' + encodeURIComponent(fixture));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const service = await createProjectionServer(source, {
      authorize: async (action) => {
        if (
          action.kind === 'pointer' &&
          action.phase === 'move' &&
          action.buttons &&
          !held
        ) {
          held = true;
          await gate;
        }
        return true;
      },
    });
    t.after(async () => {
      release();
      await service.close();
      await browser.close();
    });
    const viewer = await browser.newPage();
    viewer.setDefaultTimeout(3000);
    await observe(viewer);
    await viewer.goto(service.url);
    await viewer.locator('#status.live').waitFor();
    await settled(viewer);
    const box = (await viewer
      .frameLocator('#viewport iframe')
      .locator('#thumb')
      .boundingBox())!;
    await viewer.mouse.move(box.x + 20, box.y + 40);
    await settled(viewer);
    await viewer.mouse.down();
    await settled(viewer);
    await viewer.evaluate(
      ({ x, y }) => {
        const surface = document.querySelector('.floe-input-surface')!;
        for (let dx = 1; dx <= 300; dx++)
          surface.dispatchEvent(
            new MouseEvent('mousemove', {
              bubbles: true,
              clientX: x + dx,
              clientY: y,
              buttons: 1,
            }),
          );
      },
      { x: box.x + 20, y: box.y + 40 },
    );
    const sent = await viewer.evaluate(() =>
      (window as any).dragTest.commands.filter(
        (c: any) =>
          c.action.kind === 'pointer' &&
          c.action.phase === 'move' &&
          c.action.buttons,
      ),
    );
    assert.ok(
      sent.length <= 2,
      `At most two drag commands may wait on a blocked source, got ${sent.length}`,
    );
    await viewer.mouse.move(box.x + 320, box.y + 40);
    await viewer.mouse.up();
    release();
    await settled(viewer);
    await source.waitForFunction(
      () => Number(document.querySelector('#value')!.textContent) === 300,
    );
    assert.equal(await source.evaluate(() => (window as any).releases), 1);
    assert.deepEqual(
      await viewer.evaluate(() =>
        (window as any).dragTest.acks.filter((a: any) => !a.ok),
      ),
      [],
    );
    assert.equal(await viewer.locator('#toast').isVisible(), false);
  },
);

for (const client of [chromium, firefox, webkit])
  test(
    `${client.name()} keeps scaled child-frame dragging stable through reversal`,
    { timeout: 20000 },
    async (t) => {
      const sourceBrowser = await chromium.launch();
      const viewerBrowser = await client.launch();
      t.after(() =>
        Promise.all([sourceBrowser.close(), viewerBrowser.close()]),
      );
      const source = await sourceBrowser.newPage();
      await source.context().route('https://**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: route.request().url().includes('drag-child.test')
            ? fixture
            : `<!doctype html><style>body{margin:20px}iframe{width:800px;height:400px;border:5px solid;transform:scale(.8);transform-origin:top left}</style><iframe src="https://drag-child.test/"></iframe>`,
        }),
      );
      await source.goto('https://drag-parent.test/');
      const origin = source.frames().find((f) => f.parentFrame())!;
      const service = await createProjectionServer(source, {
        authorize: () => true,
      });
      t.after(() => service.close());
      const viewer = await viewerBrowser.newPage();
      viewer.setDefaultTimeout(4000);
      await observe(viewer);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      await settled(viewer);
      const thumb = viewer
        .frameLocator('#viewport iframe')
        .frameLocator('iframe')
        .locator('#thumb');
      const box = (await thumb.boundingBox())!;
      const scale = box.width / 180;
      await viewer.mouse.move(box.x + 20 * scale, box.y + 40 * scale);
      await settled(viewer);
      await viewer.mouse.down();
      await settled(viewer);
      await viewer.evaluate(() => ((window as any).dragTest.hold = true));
      const positions = [20, 40, 60, 80, 100, 80, 60, 40];
      for (const dx of positions) {
        await viewer.mouse.move(box.x + (20 + dx) * scale, box.y + 40 * scale);
        await settled(viewer);
      }
      const result = await origin.evaluate(() => ({
        samples: (window as any).samples,
        releases: (window as any).releases,
      }));
      assert.equal(result.releases, 0);
      assert.deepEqual(
        result.samples.map((s: any) => s.position),
        positions,
      );
      assert.ok(result.samples.every((s: any) => s.trusted && s.buttons === 1));
      await viewer.mouse.up();
      await settled(viewer);
      await viewer.evaluate(() => (window as any).dragTest.flush());
      await viewer.waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>('#viewport iframe')
            ?.contentDocument?.querySelector('iframe')
            ?.contentDocument?.querySelector('#value')?.textContent === '40',
      );
      assert.equal(await origin.evaluate(() => (window as any).releases), 1);
    },
  );

for (const ending of ['blur', 'denied', 'navigation', 'disconnect'] as const)
  test(
    `unsent pointer motion is discarded on ${ending}`,
    { timeout: 15000 },
    async (t) => {
      const browser = await chromium.launch();
      const source = await browser.newPage();
      await source.goto('data:text/html,' + encodeURIComponent(fixture));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const blocked = new Promise<void>((r) => (entered = r));
      let held = false;
      const service = await createProjectionServer(source, {
        authorize: async (a) => {
          if (
            a.kind === 'pointer' &&
            a.phase === 'move' &&
            a.buttons &&
            !held
          ) {
            held = true;
            entered();
            await gate;
            return ending !== 'denied';
          }
          return true;
        },
      });
      t.after(async () => {
        release();
        await service.close();
        await browser.close();
      });
      const viewer = await browser.newPage();
      viewer.setDefaultTimeout(3000);
      await observe(viewer);
      await viewer.goto(service.url);
      await viewer.locator('#status.live').waitFor();
      await settled(viewer);
      const box = (await viewer
        .frameLocator('#viewport iframe')
        .locator('#thumb')
        .boundingBox())!;
      await viewer.mouse.move(box.x + 20, box.y + 40);
      await settled(viewer);
      await viewer.mouse.down();
      await settled(viewer);
      await viewer.mouse.move(box.x + 40, box.y + 40);
      await blocked;
      await viewer.mouse.move(box.x + 320, box.y + 40);
      if (ending === 'blur') await viewer.locator('#address').focus();
      if (ending === 'navigation')
        await source.goto('data:text/html,<h1>New document</h1>');
      if (ending === 'disconnect') await viewer.goto('about:blank');
      release();
      if (ending === 'disconnect') {
        await source.waitForFunction(() => (window as any).releases === 1);
        assert.ok(
          !(await source.evaluate(() => (window as any).samples)).some(
            (s: any) => s.position === 300,
          ),
        );
        return;
      }
      await settled(viewer);
      await viewer.mouse.up();
      await settled(viewer);
      const moves = await viewer.evaluate(() =>
        (window as any).dragTest.commands.filter(
          (c: any) =>
            c.action.kind === 'pointer' &&
            c.action.phase === 'move' &&
            c.action.buttons,
        ),
      );
      assert.equal(
        moves.length,
        1,
        'The unsent endpoint must not survive a failed or retired gesture',
      );
      if (ending === 'navigation')
        assert.equal(await source.locator('h1').textContent(), 'New document');
      else {
        assert.equal(await source.evaluate(() => (window as any).releases), 1);
        assert.ok(
          !(await source.evaluate(() => (window as any).samples)).some(
            (s: any) => s.position === 300,
          ),
        );
      }
    },
  );

test(
  'viewport pointer continuation requires an admitted origin and live held button',
  { timeout: 15000 },
  async (t) => {
    const browser = await chromium.launch();
    const source = await browser.newPage();
    await source.goto('data:text/html,' + encodeURIComponent(fixture));
    const service = await createProjectionServer(source, {
      authorize: () => true,
    });
    t.after(async () => {
      await service.close();
      await browser.close();
    });
    const messages: any[] = [];
    let snapshotReady!: (m: any) => void;
    const ready = new Promise<any>((r) => (snapshotReady = r));
    const controller = await service.engine.connect((m) => {
      messages.push(m);
      if (m.type === 'snapshot') snapshotReady(m);
    });
    const snapshot = await ready;
    assert.ok(snapshot);
    const find = (node: any, id: string): number | undefined =>
      node.attributes?.id === id
        ? node.id
        : node.childNodes?.map((n: any) => find(n, id)).find(Boolean);
    const tree = snapshot.events.find((e: any) => e.type === 2).data.node;
    const thumb = find(tree, 'thumb')!,
      track = find(tree, 'track')!;
    assert.ok(thumb && track);
    let id = 0;
    const send = async (
      phase: 'down' | 'move' | 'up',
      node = thumb,
      captured = true,
    ) => {
      await controller.receive({
        type: 'command',
        id: ++id,
        tab: service.engine.id,
        epoch: snapshot.epoch,
        action: {
          kind: 'pointer',
          phase,
          point: {
            node,
            x: 0.2,
            y: 0.5,
            ...(captured ? { space: 'viewport' as const } : {}),
          },
          button: 'left',
          buttons: phase === 'up' ? 0 : 1,
          modifiers: 0,
          clicks: 1,
        },
      });
      return messages.findLast((m) => m.type === 'ack');
    };
    assert.equal((await send('move')).code, 'target_changed');
    assert.equal((await send('down')).code, 'target_changed');
    assert.equal((await send('down', thumb, false)).ok, true);
    assert.equal((await send('move', track)).code, 'target_changed');
    assert.equal(
      (await send('move')).code,
      'target_changed',
      'A failed origin releases authority',
    );
    assert.equal((await send('down', thumb, false)).ok, true);
    await controller.receive({
      type: 'command',
      id: ++id,
      tab: service.engine.id,
      epoch: snapshot.epoch,
      action: { kind: 'release_input' },
    });
    assert.equal((await send('move')).code, 'target_changed');
    assert.equal((await send('down', thumb, false)).ok, true);
    await source.locator('#thumb').evaluate((e) => e.remove());
    assert.equal((await send('move')).code, 'target_changed');
  },
);
