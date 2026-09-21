import {
  interactionAttributes,
  type InteractionState,
} from '../shared/style.js';

export function sourceInteraction(element: Element): InteractionState {
  return Object.fromEntries(
    Object.keys(interactionAttributes).map((name) => [
      name,
      element.matches(`:${name}`),
    ]),
  ) as InteractionState;
}

/** Observe native pseudo states without modifying website elements or defaults. */
export function observeInteraction(
  doc: Document,
  emit: (element: Element, state: InteractionState) => void,
): () => void {
  const tracked = new Map<Element, string>();
  const candidates = new Set<Element>();
  let scheduled = 0;
  const win = doc.defaultView!;
  const add = (element: Element | null) => {
    for (
      let node = element;
      node;
      node =
        node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null
    )
      candidates.add(node);
  };
  const flush = () => {
    scheduled = 0;
    for (const element of tracked.keys()) candidates.add(element);
    for (const element of candidates) {
      if (!element.isConnected) {
        tracked.delete(element);
        continue;
      }
      const state = sourceInteraction(element);
      const value = JSON.stringify(state);
      if (tracked.get(element) !== value) emit(element, state);
      if (Object.values(state).some(Boolean)) tracked.set(element, value);
      else tracked.delete(element);
    }
    candidates.clear();
  };
  const changed = (event: Event) => {
    for (const item of event.composedPath())
      if ((item as Node).nodeType === 1) add(item as Element);
    if (
      (event as MouseEvent).relatedTarget &&
      ((event as MouseEvent).relatedTarget as Node).nodeType === 1
    )
      add((event as MouseEvent).relatedTarget as Element);
    add(doc.activeElement);
    if (!scheduled) scheduled = win.requestAnimationFrame(flush);
  };
  const events = [
    'mouseover',
    'mouseout',
    'mousedown',
    'mouseup',
    'focusin',
    'focusout',
    'keydown',
    'keyup',
  ];
  for (const name of events) doc.addEventListener(name, changed, true);
  return () => {
    win.cancelAnimationFrame(scheduled);
    for (const name of events) doc.removeEventListener(name, changed, true);
    tracked.clear();
    candidates.clear();
  };
}
