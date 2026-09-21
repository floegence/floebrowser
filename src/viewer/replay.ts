import type { playerConfig } from '@rrweb/replay';
import { MATHML_ATTRIBUTE } from '../shared/style.js';
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type scrollData,
  type selectionData,
} from '@rrweb/types';

const scrollPlugin = 'floebrowser:live-scroll';
const selectionPlugin = 'floebrowser:live-selection';

/** Keep scroll positions in replay order, without rrweb's second animation. */
export function liveEvent(
  event: eventWithTime,
  timestamp: number,
): eventWithTime {
  if (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Selection
  )
    return {
      type: EventType.Plugin,
      timestamp,
      data: { plugin: selectionPlugin, payload: event.data },
    };
  if (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Scroll
  )
    return {
      type: EventType.Plugin,
      timestamp,
      data: { plugin: scrollPlugin, payload: event.data },
    };
  return { ...event, timestamp };
}

/** Empty selections must clear the previous highlight too. rrweb's default
 * selection replay only visits documents named by a non-empty range. */
export const liveSelection: NonNullable<playerConfig['plugins']>[number] = {
  handler(event, _isSync, { replayer }) {
    if (
      event.type !== EventType.Plugin ||
      event.data.plugin !== selectionPlugin
    )
      return;
    const clear = (doc?: Document | null) => {
      if (!doc) return;
      doc.getSelection()?.removeAllRanges();
      for (const frame of doc.querySelectorAll('iframe,frame'))
        clear((frame as HTMLIFrameElement).contentDocument);
    };
    clear(replayer.iframe.contentDocument);
    for (const item of (event.data.payload as selectionData).ranges) {
      const start = replayer.getMirror().getNode(item.start),
        end = replayer.getMirror().getNode(item.end);
      if (
        !start?.isConnected ||
        !end?.isConnected ||
        start.ownerDocument !== end.ownerDocument
      )
        continue;
      try {
        const range = start.ownerDocument!.createRange();
        range.setStart(start, item.startOffset);
        range.setEnd(end, item.endOffset);
        start.ownerDocument!.getSelection()?.addRange(range);
      } catch {
        /* The DOM may have removed this range before selection arrived. */
      }
    }
  },
};

export const liveScroll: NonNullable<playerConfig['plugins']>[number] = {
  handler(event, _isSync, { replayer }) {
    if (event.type !== EventType.Plugin || event.data.plugin !== scrollPlugin)
      return;
    const { id, x, y } = event.data.payload as scrollData;
    const node = replayer.getMirror().getNode(id);
    if (!node?.isConnected) return;
    const target =
      node.nodeType === 9 ? (node as Document).defaultView : (node as Element);
    // Source CSS can request smooth scrolling too. These are already-observed
    // positions, so even that animation must only run at the source.
    target?.scrollTo({ left: x, top: y, behavior: 'instant' });
  },
};

/** rrweb's whole-sheet mutation path only recognizes uppercase HTML STYLE. */
export const svgStyles: NonNullable<playerConfig['plugins']>[number] = {
  handler(event, _isSync, { replayer }) {
    if (
      event.type !== EventType.IncrementalSnapshot ||
      event.data.source !== IncrementalSource.Mutation
    )
      return;
    for (const mutation of event.data.attributes) {
      const css = mutation.attributes._cssText;
      if (typeof css !== 'string') continue;
      const node = replayer.getMirror().getNode(mutation.id) as Element | null;
      if (
        node?.localName === 'style' &&
        node.namespaceURI === 'http://www.w3.org/2000/svg'
      ) {
        node.textContent = css;
        node.removeAttribute('_cssText');
      }
    }
  },
};

/** rrweb serializes only the SVG namespace; restore native mathematical layout. */
export const mathElements: NonNullable<playerConfig['plugins']>[number] = {
  onBuild(node, { id, replayer }) {
    const element = node as Element;
    if (node.nodeType !== 1 || !element.hasAttribute(MATHML_ATTRIBUTE)) return;
    const namespace = 'http://www.w3.org/1998/Math/MathML';
    if (element.namespaceURI === namespace) return;
    const replacement = element.ownerDocument.createElementNS(
      namespace,
      element.localName,
    );
    for (const attribute of element.attributes) {
      if (attribute.namespaceURI)
        replacement.setAttributeNS(
          attribute.namespaceURI,
          attribute.name,
          attribute.value,
        );
      else replacement.setAttribute(attribute.name, attribute.value);
    }
    while (element.firstChild) replacement.appendChild(element.firstChild);
    element.replaceWith(replacement);
    replayer.getMirror().replace(id, replacement);
  },
};
