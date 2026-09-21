import { INPUT_PROXY_ATTRIBUTE } from '../shared/style.js';
type Frame = HTMLIFrameElement;

/** Inert frame coordinates are independent of the trusted host input surface. */
export function replayHit(
  frame: Frame,
  clientX: number,
  clientY: number,
): { target: Element; x: number; y: number } | undefined {
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x =
    ((clientX - rect.left) * frame.offsetWidth) / rect.width - frame.clientLeft;
  const y =
    ((clientY - rect.top) * frame.offsetHeight) / rect.height - frame.clientTop;
  const doc = frame.contentDocument;
  if (
    !doc ||
    x < 0 ||
    y < 0 ||
    x >= frame.clientWidth ||
    y >= frame.clientHeight
  )
    return;
  let target = doc.elementFromPoint(x, y);
  while (target?.shadowRoot) {
    const child = target.shadowRoot.elementFromPoint(x, y);
    if (!child || child === target) break;
    target = child;
  }
  if (!target) return;
  if (target.matches('iframe,frame')) {
    const child = replayHit(target as Frame, x, y);
    if (child) return child;
  }
  for (
    let node: Element | null = target;
    node;
    node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null
  )
    if (node.matches('object,embed,[data-floebrowser-unsupported]')) return;
  return { target, x, y };
}

/** Return host viewport geometry, including nested frame borders and scaling. */
export function replayBounds(element: Element, host: Document): DOMRect {
  const rect = element.getBoundingClientRect();
  let { x, y, width, height } = rect;
  for (
    let win = element.ownerDocument.defaultView;
    win?.frameElement && win.document !== host;
    win = win.frameElement.ownerDocument.defaultView
  ) {
    const frame = win.frameElement as Frame;
    const bounds = frame.getBoundingClientRect();
    const sx = bounds.width / frame.offsetWidth;
    const sy = bounds.height / frame.offsetHeight;
    x = bounds.x + (frame.clientLeft + x) * sx;
    y = bounds.y + (frame.clientTop + y) * sy;
    width *= sx;
    height *= sy;
  }
  return new DOMRect(x, y, width, height);
}

/** Copy presentation only. No website attributes, event handlers or URL styles. */
export function styleInputProxy(
  proxy: HTMLElement,
  element: HTMLElement,
  container: HTMLElement,
): void {
  const rect = replayBounds(element, container.ownerDocument);
  const origin = container.getBoundingClientRect();
  const local = element.getBoundingClientRect();
  if (!local.width || !local.height) {
    proxy.style.visibility = 'hidden';
    return;
  }
  proxy.style.visibility = '';
  element.removeAttribute(INPUT_PROXY_ATTRIBUTE);
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  for (const property of [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-stretch',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-align',
    'text-indent',
    'text-transform',
    'direction',
    'writing-mode',
    'color',
    'background-color',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'border-radius',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'appearance',
    'caret-color',
    'tab-size',
    'outline-color',
    'outline-width',
    'outline-style',
    'outline-offset',
    'box-shadow',
    'opacity',
  ])
    proxy.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(proxy.style, {
    left: `${rect.left - origin.left + container.scrollLeft}px`,
    top: `${rect.top - origin.top + container.scrollTop}px`,
    width: `${local.width}px`,
    height: `${local.height}px`,
    transform: `scale(${rect.width / local.width}, ${rect.height / local.height})`,
  });
  // A focused child field must not paint over its frame boundary or an ancestor
  // scroller. Pointer hit testing already follows those boundaries independently.
  // Outlines and decorative shadows may extend beyond the field itself.
  // Clip them only at a real containing boundary, not at the input border.
  let left = origin.left,
    top = origin.top,
    right = origin.right,
    bottom = origin.bottom;
  for (
    let node: Element | null = element;
    node && node.ownerDocument !== container.ownerDocument;
  ) {
    const parent: Element | null =
      node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
    if (parent) {
      const style = parent.ownerDocument.defaultView!.getComputedStyle(parent);
      const bounds = replayBounds(parent, container.ownerDocument);
      if (style.overflowX !== 'visible') {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (style.overflowY !== 'visible') {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
      node = parent;
    } else {
      node = node.ownerDocument.defaultView?.frameElement ?? null;
      if (node) {
        const bounds = replayBounds(node, container.ownerDocument);
        const frame = node as Frame;
        const sx = bounds.width / frame.offsetWidth,
          sy = bounds.height / frame.offsetHeight;
        left = Math.max(left, bounds.left + frame.clientLeft * sx);
        top = Math.max(top, bounds.top + frame.clientTop * sy);
        right = Math.min(
          right,
          bounds.left + (frame.clientLeft + frame.clientWidth) * sx,
        );
        bottom = Math.min(
          bottom,
          bounds.top + (frame.clientTop + frame.clientHeight) * sy,
        );
      }
    }
  }
  element.setAttribute(INPUT_PROXY_ATTRIBUTE, '');
  const sx = local.width / rect.width,
    sy = local.height / rect.height;
  proxy.style.clipPath = `inset(${(top - rect.top) * sy}px ${(rect.right - right) * sx}px ${(rect.bottom - bottom) * sy}px ${(left - rect.left) * sx}px)`;
}
