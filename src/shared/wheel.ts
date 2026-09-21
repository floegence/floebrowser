type WheelLocation = {
  space: 'client' | 'viewport';
  x: number;
  y: number;
  dx: number;
  dy: number;
};

/** Self-contained so the same geometry contract runs in the viewer and source. */
export function mapWheelPoint(
  target: Element,
  location: WheelLocation,
): { node?: Element; x: number; y: number } | undefined {
  const doc = target.ownerDocument;
  const win = doc.defaultView!;
  const parent = (node: Element): Element | null =>
    node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
  const regionFor = (start: Element): Element => {
    for (let node: Element | null = start; node; node = parent(node)) {
      if (node === doc.documentElement || node === doc.scrollingElement) break;
      const style = win.getComputedStyle(node);
      // Keep the same region at its scroll boundary; Chromium owns chaining.
      if (
        (location.dy &&
          /^(auto|scroll|overlay)$/.test(style.overflowY) &&
          node.scrollHeight > node.clientHeight) ||
        (location.dx &&
          /^(auto|scroll|overlay)$/.test(style.overflowX) &&
          node.scrollWidth > node.clientWidth)
      )
        return node;
    }
    return doc.documentElement;
  };
  const supported = (node: Element) => {
    for (let current: Element | null = node; current; current = parent(current))
      if (current.matches('object,embed,[data-floebrowser-unsupported]'))
        return false;
    return true;
  };
  if (!target.isConnected || !supported(target)) return;
  const region = location.space === 'client' ? regionFor(target) : target;
  // Wheel location is stable in the frame viewport, including while a child
  // scroller chains into an ancestor and moves offscreen.
  if (location.space === 'client') {
    return {
      node: region,
      x: Math.max(0, Math.min(1, location.x / win.innerWidth)),
      y: Math.max(0, Math.min(1, location.y / win.innerHeight)),
    };
  }
  const x = win.innerWidth * location.x;
  const y = win.innerHeight * location.y;
  if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight) return;
  if (region !== doc.documentElement) {
    const bounds = region.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
  }
  let hit = (region.getRootNode() as Document | ShadowRoot).elementFromPoint(
    x,
    y,
  );
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit || !supported(hit)) return;
  const hitRegion = regionFor(hit);
  // Permit native chaining only through exhausted scroll ancestors. A new
  // unrelated scroller or replacement cannot receive the queued input.
  let current = region;
  while (current !== hitRegion) {
    if (current === doc.documentElement) return;
    const style = win.getComputedStyle(current);
    for (const [delta, offset, extent, behavior, overflow] of [
      [
        location.dy,
        current.scrollTop,
        current.scrollHeight - current.clientHeight,
        style.overscrollBehaviorY,
        style.overflowY,
      ],
      [
        location.dx,
        current.scrollLeft +
          (style.direction === 'rtl'
            ? current.scrollWidth - current.clientWidth
            : 0),
        current.scrollWidth - current.clientWidth,
        style.overscrollBehaviorX,
        style.overflowX,
      ],
    ] as const) {
      if (!delta || !/^(auto|scroll|overlay)$/.test(overflow)) continue;
      if (behavior !== 'auto' || (delta > 0 ? offset < extent - 1 : offset > 1))
        return;
    }
    current = regionFor(parent(current) ?? doc.documentElement);
  }
  return { x, y };
}
