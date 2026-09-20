import { observeMedia } from './media-source.js';
import { record } from '@rrweb/record';
import type { MediaConfiguration } from '../shared/protocol.js';
import type { ICrossOriginIframeMirror } from '@rrweb/types';
import { UNSUPPORTED_SELECTOR } from '../shared/protocol.js';

/** Runs inside source documents. Relay credentials must be scoped and short-lived. */
export function installRecorder(
  binding: string,
  key: string,
  configuration: MediaConfiguration,
): void {
  // rrweb's parent recorder already covers same-origin child documents.
  if (window !== window.top) {
    try {
      if (window.parent.document) return;
    } catch {
      /* Cross-origin recorder root. */
    }
  }
  const target = window as unknown as Record<string, any>;
  if (target[key]) return;
  let frameMirror: ICrossOriginIframeMirror;
  const frameIDs = new Set<number>();
  let lastTitle = document.title;
  let mediaActive = false;
  const media = new Set<ReturnType<typeof observeMedia>>();
  const currentImage = (node: any) => {
    if (node.type === 2 && ['iframe', 'frame'].includes(node.tagName))
      frameIDs.add(node.id);
    if (node.type === 0)
      node.floeBase ??=
        record.mirror.getNode(node.id)?.baseURI ?? document.baseURI;
    if (node.type === 2 && node.tagName === 'img') {
      const image = record.mirror.getNode(node.id);
      if (image?.nodeName === 'IMG')
        node.attributes.src =
          (image as HTMLImageElement).currentSrc ||
          (image as HTMLImageElement).src;
    }
    for (const child of node.childNodes ?? []) currentImage(child);
  };
  const prepare = (event: any) => {
    if (event.type === 2) frameIDs.clear();
    if (event.type === 2) event.data.node.floeBase = document.baseURI;
    if (event.type === 2) currentImage(event.data.node);
    if (event.type === 3 && event.data.source === 0) {
      for (const addition of event.data.adds) currentImage(addition.node);
    }
    if (
      window === window.top &&
      event.type === 3 &&
      document.title !== lastTitle
    ) {
      lastTitle = document.title;
      record.addCustomEvent('floebrowser:title', { title: lastTitle });
    }
    return event;
  };
  const emit = (event: any) => {
    try {
      target[binding](JSON.stringify(event));
    } catch {
      /* The host detached. */
    }
  };
  const stop = record({
    emit,
    blockSelector: UNSUPPORTED_SELECTOR,
    inlineStylesheet: true,
    inlineImages: false,
    recordCanvas: false,
    recordCrossOriginIframes: true,
    recordAfter: 'DOMContentLoaded',
    plugins: [
      {
        name: 'floebrowser',
        options: {},
        eventProcessor: prepare,
        observer: (_callback, win) => {
          const doc = win.document;
          const observer = observeMedia(
            doc,
            key,
            configuration,
            (node) => record.mirror.getId(node),
            (packet) => record.addCustomEvent('floebrowser:media', packet),
          );
          media.add(observer);
          observer.setEnabled(mediaActive);
          const changed = () => queueMicrotask(() => emitFocus(doc));
          const loaded = (event: Event) => {
            const image = event.target as HTMLImageElement;
            if (image?.nodeName !== 'IMG') return;
            const id = record.mirror.getId(image);
            if (id > 0)
              record.addCustomEvent('floebrowser:image', {
                id,
                src: image.currentSrc || image.src,
              });
          };
          for (const event of ['focusin', 'selectionchange', 'input'])
            doc.addEventListener(event, changed, true);
          doc.addEventListener('load', loaded, true);
          return () => {
            observer.close();
            media.delete(observer);
            for (const event of ['focusin', 'selectionchange', 'input'])
              doc.removeEventListener(event, changed, true);
            doc.removeEventListener('load', loaded, true);
          };
        },
        getMirror: ({ crossOriginIframeMirror }) => {
          frameMirror = crossOriginIframeMirror;
        },
      },
    ],
    collectFonts: true,
    maskInputOptions: { password: true },
    sampling: {
      mousemove: false,
      mouseInteraction: false,
      scroll: 16,
      input: 'all',
    },
  });
  let previousFocus = '';
  function emitFocus(doc = document, force = false): void {
    let element = doc.activeElement;
    while (element?.shadowRoot?.activeElement)
      element = element.shadowRoot.activeElement;
    const input = ['INPUT', 'TEXTAREA'].includes(element?.tagName ?? '')
      ? (element as HTMLInputElement | HTMLTextAreaElement)
      : undefined;
    const focus = {
      id: element ? Math.max(0, record.mirror.getId(element)) : 0,
      start: input?.selectionStart ?? null,
      end: input?.selectionEnd ?? null,
      direction: input?.selectionDirection ?? null,
    };
    const serialized = JSON.stringify(focus);
    if (force || serialized !== previousFocus) {
      previousFocus = serialized;
      record.addCustomEvent('floebrowser:focus', focus);
    }
  }
  Object.defineProperty(target, key, {
    configurable: true,
    value: {
      media: (active: boolean) => {
        mediaActive = active;
        for (const observer of media) observer.setEnabled(active);
      },
      retireMedia: (streams: string[]) => {
        for (const observer of media) observer.retire(streams);
      },
      snapshot: () => {
        record.takeFullSnapshot();
        emitFocus(document, true);
      },
      resolve: (id: number) => {
        const node = record.mirror.getNode(id);
        if (node?.isConnected)
          return { node: node.nodeType === 1 ? node : node.parentElement };
        for (const frameID of frameIDs) {
          const frame = record.mirror.getNode(
            frameID,
          ) as HTMLIFrameElement | null;
          if (!frame?.isConnected) {
            frameIDs.delete(frameID);
            continue;
          }
          if (frame?.nodeName !== 'IFRAME' && frame?.nodeName !== 'FRAME')
            continue;
          const remote = frameMirror.getRemoteId(frame, id);
          if (remote > 0) return { frame, id: remote };
        }
        return {};
      },
      stop: () => {
        for (const observer of media) observer.close();
        media.clear();
        stop?.();
        delete target[key];
      },
    },
  });
}
