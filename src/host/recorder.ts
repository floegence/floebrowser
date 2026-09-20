import { record } from '@rrweb/record';
import { UNSUPPORTED_SELECTOR } from '../shared/protocol.js';

/** Runs exclusively inside the source page; contains no host credentials. */
export function installRecorder(binding: string, key: string): void {
  if (window !== window.top) return;
  const target = window as unknown as Record<string, any>;
  if (target[key]) return;
  const currentImage = (node: any) => {
    if (node.type === 2 && node.tagName === 'img') {
      const image = record.mirror.getNode(node.id);
      if (image instanceof HTMLImageElement)
        node.attributes.src = image.currentSrc || image.src;
    }
    for (const child of node.childNodes ?? []) currentImage(child);
  };
  const emit = (event: any) => {
    if (event.type === 2) currentImage(event.data.node);
    if (event.type === 3 && event.data.source === 0) {
      for (const addition of event.data.adds) currentImage(addition.node);
    }
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
    collectFonts: true,
    maskInputOptions: { password: true },
    sampling: {
      mousemove: false,
      mouseInteraction: false,
      scroll: 30,
      input: 'all',
    },
  });
  let previousFocus = '';
  function emitFocus(force = false): void {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement)
      element = element.shadowRoot.activeElement;
    const input =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element
        : undefined;
    const focus = {
      node: element ? Math.max(0, record.mirror.getId(element)) : 0,
      start: input?.selectionStart ?? null,
      end: input?.selectionEnd ?? null,
      direction: input?.selectionDirection ?? null,
    };
    const serialized = JSON.stringify(focus);
    if (force || serialized !== previousFocus) {
      previousFocus = serialized;
      emit({
        type: 5,
        timestamp: Date.now(),
        data: { tag: 'floebrowser:focus', payload: focus },
      });
    }
  }
  const focusChanged = () => {
    queueMicrotask(() => emitFocus());
  };
  for (const event of ['focusin', 'selectionchange', 'input'])
    document.addEventListener(event, focusChanged, true);
  const loaded = (event: Event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const id = record.mirror.getId(image);
    if (id > 0)
      emit({
        type: 3,
        timestamp: Date.now(),
        data: {
          source: 0,
          adds: [],
          removes: [],
          texts: [],
          attributes: [
            { id, attributes: { src: image.currentSrc || image.src } },
          ],
        },
      });
  };
  document.addEventListener('load', loaded, true);
  Object.defineProperty(target, key, {
    configurable: true,
    value: {
      snapshot: () => {
        record.takeFullSnapshot();
        emitFocus(true);
      },
      stop: () => {
        stop?.();
        document.removeEventListener('load', loaded, true);
        for (const event of ['focusin', 'selectionchange', 'input'])
          document.removeEventListener(event, focusChanged, true);
        delete target[key];
      },
      point: (id: number, x: number, y: number) => {
        const node = record.mirror.getNode(id);
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element?.isConnected || element.closest(UNSUPPORTED_SELECTOR))
          return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const px = Math.max(
          0,
          Math.min(innerWidth - 1, rect.x + rect.width * x),
        );
        const py = Math.max(
          0,
          Math.min(innerHeight - 1, rect.y + rect.height * y),
        );
        const root = element.getRootNode() as Document | ShadowRoot;
        const hit = root.elementFromPoint(px, py);
        if (!hit || !(hit === element || element.contains(hit))) return null;
        return { x: px, y: py };
      },
      select: (id: number, values: string[]) => {
        const element = record.mirror.getNode(id);
        if (
          !(element instanceof HTMLSelectElement) ||
          !element.isConnected ||
          element.disabled
        )
          return false;
        if (!element.multiple && values.length !== 1) return false;
        if (
          values.some(
            (value) =>
              !Array.from(element.options).some(
                (option) => option.value === value && !option.disabled,
              ),
          )
        )
          return false;
        element.focus();
        for (const option of element.options)
          option.selected = values.includes(option.value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
    },
  });
}
