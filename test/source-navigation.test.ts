import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CDPSourcePage } from '../src/host/cdp-source.js';

for (const accepted of [false, true]) {
  test(`an aborted navigation waits for the outstanding beforeunload decision: accept=${accepted}`, async (t) => {
    class Transport extends EventEmitter {
      async send(method: string) {
        if (method === 'Page.getFrameTree')
          return {
            frameTree: {
              frame: {
                id: 'main',
                url: 'https://source.test/',
                loaderId: 'initial',
              },
            },
          };
        if (method === 'Page.navigate') {
          this.emit('Page.javascriptDialogOpening', {
            type: 'beforeunload',
            url: 'https://source.test/',
            message: '',
          });
          return { errorText: 'net::ERR_ABORTED' };
        }
        return {};
      }
    }
    const transport = new Transport();
    const source = await CDPSourcePage.attach({ id: 'source', transport });
    t.after(() => source.dispose());
    let result = 'pending';
    const navigation = source.navigate('https://source.test/next').then(
      () => {
        result = 'resolved';
      },
      () => {
        result = 'rejected';
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      result,
      'pending',
      'A CDP abort cannot decide the still-open source dialog',
    );
    transport.emit('Page.javascriptDialogClosed', { result: accepted });
    await navigation;
    assert.equal(result, accepted ? 'rejected' : 'resolved');
    assert.equal(transport.listenerCount('Page.lifecycleEvent'), 0);
  });
}
