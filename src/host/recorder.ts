import { observeCanvas } from './canvas-source.js';
import { observeMedia } from './media-source.js';
import { observeInteraction, sourceInteraction } from './interaction-source.js';
import { UNSUPPORTED_SELECTOR } from '../shared/protocol.js';
import { record } from '@rrweb/record';
import {
  EventType,
  IncrementalSource,
  type ICrossOriginIframeMirror,
} from '@rrweb/types';
import { styleAttributes, type SourceStylesheet } from '../shared/style.js';

/** Runs only inside source documents; media signaling terminates on this host. */
export function installRecorder(binding: string, key: string): void {
  // Browser-owned error and security documents are not website DOM.
  if (
    !['http:', 'https:', 'about:', 'blob:', 'data:'].includes(location.protocol)
  )
    return;
  // Observe native rendering before page scripts run, including child frames.
  // Pixels stay in a bounded source-local cache until an authorized receiver exists.
  const canvas = observeCanvas(window, `${key}:canvas`);
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
  const styleBases = new Map<number, string>();
  const styleSheets = new Map<number, WeakRef<CSSStyleSheet>>();
  // Keep authored syntax only while it represents the live stylesheet. CSSOM
  // edits do not update a style element's text and must survive reconstruction.
  const authoredStyles = new WeakMap<
    Element,
    { text: string; serialized: string }
  >();
  const serializeSheet = (sheet: CSSStyleSheet) =>
    Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
  let styleIDs = new WeakMap<CSSStyleSheet, number>();
  let mediaActive = false;
  let picturesActive = true;
  let projecting = true;
  let recordedDocument = false;
  const media = new Set<ReturnType<typeof observeMedia>>();
  const rawAttributes = (element: Element, keys: string[]) =>
    Object.fromEntries(
      keys
        .filter((name) => Object.hasOwn(styleAttributes, name))
        .map((name) => [name, element.getAttribute(name)]),
    );
  const canvasSize = (element: HTMLCanvasElement) => ({
    width: element.width,
    height: element.height,
  });
  const stylesheet = (
    element: HTMLLinkElement | HTMLStyleElement,
    captured?: string,
  ): SourceStylesheet => {
    let text: string | null = captured ?? null;
    try {
      if (element.sheet) {
        const serialized = serializeSheet(element.sheet);
        if (element.localName === 'style') {
          const authored = element.textContent ?? '';
          let cached = authoredStyles.get(element);
          if (!cached || cached.text !== authored) {
            // An inert document has no browsing context or resource loader. It
            // parses imports too, unlike a constructed CSSStyleSheet. Compare
            // CSSOM forms, but transmit the authored shorthand when equivalent:
            // Chromium serializes pending var() shorthand longhands as empty.
            const inert =
              element.ownerDocument.implementation.createHTMLDocument();
            const style = inert.createElement('style');
            style.textContent = authored;
            inert.head.append(style);
            cached = {
              text: authored,
              serialized: serializeSheet(style.sheet!),
            };
            authoredStyles.set(element, cached);
          }
          text = cached.serialized === serialized ? cached.text : serialized;
        } else if (text === null) text = serialized;
      }
    } catch {
      /* Cross-origin sheets use captured source responses. */
    }
    return {
      href:
        element.sheet?.href ||
        ('href' in element ? element.href : element.baseURI),
      text,
      enabled:
        (!('relList' in element) || element.relList.contains('stylesheet')) &&
        !element.disabled &&
        !element.sheet?.disabled,
      media: element.media,
    };
  };
  // Observe only serialized objects, including those in shadow roots and child
  // documents. MutationObserver's node list and this mode map hold weak keys.
  // Crossing the embedding boundary requires a fresh authoritative checkpoint;
  // ordinary HTML edits keep the existing incremental path and input epoch.
  const objectModes = new WeakMap<Element, boolean>();
  const objectObserver = new MutationObserver((records) => {
    let changed = false;
    for (const { target } of records) {
      const element = target as Element;
      if (!element.isConnected) continue;
      const fallback = !element.matches(UNSUPPORTED_SELECTOR);
      if (objectModes.get(element) !== fallback) changed = true;
      objectModes.set(element, fallback);
    }
    if (changed && projecting && recordedDocument) {
      record.takeFullSnapshot();
      emitFocus(document, true);
    }
  });
  const prepareNode = (node: any, root = true) => {
    if (node.type === 2 && ['iframe', 'frame'].includes(node.tagName))
      frameIDs.add(node.id);
    if (node.type === 0)
      node.floeBase ??=
        record.mirror.getNode(node.id)?.baseURI ?? document.baseURI;
    if (node.type === 2) {
      const element = record.mirror.getNode(node.id) as Element | null;
      if (element?.nodeType === 1) {
        node.floeInteraction = sourceInteraction(element);
        if (element.localName === 'object') {
          node.floeObjectFallback = !element.matches(UNSUPPORTED_SELECTOR);
          objectModes.set(element, node.floeObjectFallback);
          objectObserver.observe(element, {
            attributes: true,
            attributeFilter: ['data', 'type'],
          });
        }
        if (element.localName === 'canvas')
          node.floeCanvas ??= canvasSize(element as HTMLCanvasElement);
        if (element.namespaceURI === 'http://www.w3.org/1998/Math/MathML')
          node.floeNamespace = element.namespaceURI;
        const raw = rawAttributes(element, [
          ...new Set([
            ...Object.keys(node.attributes),
            ...element.getAttributeNames(),
            ...(element.localName === 'img' ? ['src'] : []),
          ]),
        ]);
        if (Object.keys(raw).length) node.floeAttributes ??= raw;
        if (root || ['link', 'style'].includes(element.localName))
          node.floeBase ??= element.baseURI;
        if (['link', 'style'].includes(element.localName)) {
          node.floeStylesheet ??= stylesheet(
            element as HTMLLinkElement | HTMLStyleElement,
            node.attributes._cssText,
          );
          delete node.attributes._cssText;
        }
      }
    }
    if (node.type === 2 && node.tagName === 'img') {
      const image = record.mirror.getNode(node.id);
      if (image?.nodeName === 'IMG')
        node.attributes.src =
          (image as HTMLImageElement).currentSrc ||
          (image as HTMLImageElement).src;
    }
    for (const child of node.childNodes ?? []) prepareNode(child, false);
  };
  const prepare = (event: any) => {
    if (event.type === EventType.FullSnapshot) {
      // Cross-origin roots forward to their parent instead of calling emit.
      recordedDocument = true;
      frameIDs.clear();
      styleBases.clear();
      styleSheets.clear();
      styleIDs = new WeakMap();
    }
    if (event.type === 5 && event.data.tag === 'floebrowser:adopted-sheet') {
      const { styleId, text, base } = event.data.payload;
      return {
        type: 3,
        timestamp: event.timestamp,
        data: {
          source: IncrementalSource.StyleSheetRule,
          styleId,
          replaceSync: text,
          floeBase: base,
        },
      };
    }
    if (event.type === 2) event.data.node.floeBase = document.baseURI;
    if (event.type === 2) prepareNode(event.data.node);
    if (event.type === 3 && event.data.source === 0) {
      const changedStyles = new Map<number, Element>();
      const styleChanged = (id: number) => {
        const node = record.mirror.getNode(id) as Element | null;
        if (node?.localName !== 'style') return false;
        changedStyles.set(id, node);
        return true;
      };
      event.data.adds = event.data.adds.filter(
        (entry: any) => !styleChanged(entry.parentId),
      );
      event.data.removes = event.data.removes.filter(
        (entry: any) => !styleChanged(entry.parentId),
      );
      event.data.texts = event.data.texts.filter((entry: any) => {
        const parent = record.mirror.getNode(entry.id)?.parentElement;
        return !parent || !styleChanged(record.mirror.getId(parent));
      });
      for (const id of changedStyles.keys())
        if (!event.data.attributes.some((entry: any) => entry.id === id))
          event.data.attributes.push({ id, attributes: {} });
      for (const addition of event.data.adds) prepareNode(addition.node);
      for (const entry of event.data.attributes) {
        const element = record.mirror.getNode(entry.id) as Element | null;
        if (element?.nodeType === 1) {
          if (element.localName === 'canvas')
            entry.floeCanvas ??= canvasSize(element as HTMLCanvasElement);
          entry.floeAttributes ??= rawAttributes(
            element,
            Object.keys(entry.attributes),
          );
          entry.floeBase ??= element.baseURI;
          if (['link', 'style'].includes(element.localName)) {
            entry.floeStylesheet ??= stylesheet(
              element as HTMLLinkElement | HTMLStyleElement,
              entry.attributes._cssText,
            );
            delete entry.attributes._cssText;
          }
        }
      }
    }
    if (
      event.type === 3 &&
      [
        IncrementalSource.StyleSheetRule,
        IncrementalSource.StyleDeclaration,
        IncrementalSource.AdoptedStyleSheet,
      ].includes(event.data.source)
    ) {
      const data = event.data;
      const node = record.mirror.getNode(data.id) as
        (Node & { sheet?: CSSStyleSheet }) | null;
      data.floeBase ??=
        node?.sheet?.href ||
        node?.baseURI ||
        styleBases.get(data.styleId) ||
        document.baseURI;
      if (data.source === IncrementalSource.AdoptedStyleSheet) {
        const sheets =
          node?.nodeType === 9
            ? (node as Document).adoptedStyleSheets
            : (node as Element | null)?.shadowRoot?.adoptedStyleSheets;
        data.styleIds.forEach((id: number, index: number) => {
          styleBases.set(id, data.floeBase);
          const sheet = sheets?.[index];
          if (!sheet) return;
          styleIDs.set(sheet, id);
          styleSheets.set(id, new WeakRef(sheet));
          if (sheet.disabled)
            for (const entry of data.styles ?? [])
              if (entry.styleId === id) entry.rules = [];
        });
      } else if (styleSheets.get(data.styleId)?.deref()?.disabled) {
        // Mutations to a disabled constructed sheet become visible together
        // when it is re-enabled, using the then-current source rules.
        event.data = {
          source: IncrementalSource.StyleSheetRule,
          styleId: data.styleId,
          replaceSync: '',
          floeBase: data.floeBase,
        };
      }
    }
    return event;
  };
  const emit = (event: any) => {
    // Background pages keep running, but their DOM never fills the host pipe.
    if (
      !projecting &&
      event.type !== 4 &&
      !(
        event.type === 5 &&
        mediaActive &&
        event.data.tag === 'floebrowser:media'
      )
    )
      return;
    try {
      target[binding](JSON.stringify(event));
    } catch {
      /* The host detached. */
    }
  };
  const stop = record({
    emit,
    // Canvas element attributes carry layout; its pixels are never recorded.
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
          const changedSheet = (sheet: CSSStyleSheet) => {
            const owner = sheet.ownerNode as
              HTMLLinkElement | HTMLStyleElement | null;
            if (owner && ['link', 'style'].includes(owner.localName)) {
              const id = record.mirror.getId(owner);
              if (id > 0)
                record.addCustomEvent('floebrowser:stylesheet', {
                  id,
                  stylesheet: stylesheet(owner),
                });
            } else {
              const styleId = styleIDs.get(sheet);
              if (styleId !== undefined)
                record.addCustomEvent('floebrowser:adopted-sheet', {
                  styleId,
                  text: sheet.disabled
                    ? ''
                    : Array.from(sheet.cssRules, (rule) => rule.cssText).join(
                        '\n',
                      ),
                  base: styleBases.get(styleId) ?? doc.baseURI,
                });
            }
          };
          const prototype = Object.getPrototypeOf(win.CSSStyleSheet.prototype);
          const disabled = Object.getOwnPropertyDescriptor(
            prototype,
            'disabled',
          );
          const setDisabled = function (this: CSSStyleSheet, value: boolean) {
            disabled!.set!.call(this, value);
            try {
              changedSheet(this);
            } catch {
              /* Observation must not change a successful source setter. */
            }
          };
          if (disabled?.configurable && disabled.set)
            Object.defineProperty(prototype, 'disabled', {
              ...disabled,
              set: setDisabled,
            });
          const canvasObserver = observeCanvas(win, `${key}:canvas`);
          const observer = observeMedia(
            doc,
            key,
            (node) => record.mirror.getId(node),
            (packet) => record.addCustomEvent('floebrowser:media', packet),
          );
          media.add(observer);
          observer.setEnabled(mediaActive, picturesActive);
          // A repeated click can leave both focus and selection unchanged. The
          // viewer retires its input proxy while the gesture is in flight, so
          // every completed pointer gesture must confirm current source focus.
          const changed = (event: Event) =>
            queueMicrotask(() => emitFocus(doc, event.type === 'mouseup'));
          const stopInteraction = observeInteraction(doc, (element, state) => {
            const id = record.mirror.getId(element);
            if (id > 0)
              record.addCustomEvent('floebrowser:interaction', { id, state });
          });
          const loaded = (event: Event) => {
            const link = event.target as HTMLLinkElement;
            if (link?.nodeName === 'LINK') {
              const id = record.mirror.getId(link);
              if (id > 0)
                record.addCustomEvent('floebrowser:stylesheet', {
                  id,
                  stylesheet: stylesheet(link),
                });
              return;
            }
            const image = event.target as HTMLImageElement;
            if (image?.nodeName !== 'IMG') return;
            const id = record.mirror.getId(image);
            if (id > 0)
              record.addCustomEvent('floebrowser:image', {
                id,
                src: image.currentSrc || image.src,
                rawSrc: image.getAttribute('src'),
              });
          };
          for (const event of [
            'focusin',
            'selectionchange',
            'input',
            'mouseup',
          ])
            doc.addEventListener(event, changed, true);
          doc.addEventListener('load', loaded, true);
          return () => {
            if (
              disabled &&
              Object.getOwnPropertyDescriptor(prototype, 'disabled')?.set ===
                setDisabled
            )
              Object.defineProperty(prototype, 'disabled', disabled);
            observer.close();
            stopInteraction();
            canvasObserver.close();
            media.delete(observer);
            for (const event of [
              'focusin',
              'selectionchange',
              'input',
              'mouseup',
            ])
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
      display: (visible: boolean) => {
        projecting = visible;
      },
      media: (active: boolean, pictures = true) => {
        mediaActive = active;
        picturesActive = pictures;
        for (const observer of media) observer.setEnabled(active, pictures);
      },
      retireMedia: (streams: string[]) => {
        for (const observer of media) observer.retire(streams);
      },
      snapshot: () => {
        projecting = true;
        // Admission can precede DOMContentLoaded in a popup or slow document.
        // Its first natural snapshot will satisfy observation when rrweb starts;
        // readyState alone is insufficient while deferred scripts are pending.
        if (!recordedDocument) return;
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
        canvas.close();
        objectObserver.disconnect();
        media.clear();
        stop?.();
        delete target[key];
      },
    },
  });
}
