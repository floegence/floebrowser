import { randomUUID } from 'node:crypto';
import type { SourceTransport } from './source.js';

// Chromium's Target events do not report document.title mutations. Observe
// only the top document's title in an isolated world, without starting DOM or
// media projection and without exposing a host binding to website scripts.
export async function observeSourceTitle(
  transport: SourceTransport,
  changed: (title: string) => void,
): Promise<() => void> {
  const name = `__floebrowser_title_${randomUUID().replaceAll('-', '')}`;
  const contexts = new Set<number>();
  const created = ({ context }: any) => {
    if (context.name === name) contexts.add(context.id);
  };
  const destroyed = ({ executionContextId }: any) =>
    contexts.delete(executionContextId);
  const cleared = () => contexts.clear();
  const called = (event: any) => {
    if (
      event.name === name &&
      contexts.has(event.executionContextId) &&
      typeof event.payload === 'string' &&
      event.payload.length <= 512
    )
      changed(event.payload);
  };
  transport.on('Runtime.executionContextCreated', created);
  transport.on('Runtime.executionContextDestroyed', destroyed);
  transport.on('Runtime.executionContextsCleared', cleared);
  transport.on('Runtime.bindingCalled', called);
  let script: string | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    transport.off('Runtime.executionContextCreated', created);
    transport.off('Runtime.executionContextDestroyed', destroyed);
    transport.off('Runtime.executionContextsCleared', cleared);
    transport.off('Runtime.bindingCalled', called);
    if (script)
      void transport
        .send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: script,
        })
        .catch(() => {});
    for (const contextId of contexts)
      void transport
        .send('Runtime.evaluate', {
          contextId,
          expression: 'globalThis.stopTitleObserver?.()',
        })
        .catch(() => {});
    contexts.clear();
    void transport.send('Runtime.removeBinding', { name }).catch(() => {});
  };
  try {
    await transport.send('Runtime.addBinding', {
      name,
      executionContextName: name,
    });
    const result = await transport.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        worldName: name,
        runImmediately: true,
        source: `(${titleObserverSource})(${JSON.stringify(name)})`,
      },
    );
    script = result.identifier;
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

const titleObserverSource = `function(name) {
  if (window !== window.top) return;
  const target = globalThis;
  let title;
  let head = null;
  const publish = () => {
    const next = document.title.slice(0, 512);
    if (next === title) return;
    title = next;
    target[name](next);
  };
  const contents = new MutationObserver(publish);
  const roots = new MutationObserver(() => ready());
  // Documents may not have an html/head element yet when an init script runs.
  const ready = () => {
    roots.disconnect();
    roots.observe(document, { childList: true });
    if (document.documentElement) roots.observe(document.documentElement, { childList: true });
    head = document.head;
    contents.disconnect();
    if (head) contents.observe(head, { subtree: true, childList: true, characterData: true });
    publish();
  };
  document.addEventListener('DOMContentLoaded', ready, { once: true });
  ready();
  target.stopTitleObserver = () => {
    roots.disconnect(); contents.disconnect();
    document.removeEventListener('DOMContentLoaded', ready);
    delete target.stopTitleObserver;
  };
}`;
