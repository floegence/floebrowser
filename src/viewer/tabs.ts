import { browserText, type BrowserText } from './messages.js';
type Gesture = {
  id: string;
  pointer: number;
  start: number;
  x: number;
  y: number;
  grab: number;
  moved: boolean;
  order: string[];
};

/** A drag is a local preview; the session remains the owner of committed order. */
export class TabOrder {
  private lifetime = new AbortController();
  private order: string[] = [];
  private gesture?: Gesture;
  private pending?: string[];
  private animation = 0;
  private suppressClick = false;
  constructor(
    private list: HTMLElement,
    private available: () => boolean,
    private move: (tab: string, before: string | null) => Promise<boolean>,
    private announce: (message: string) => void,
    private text: BrowserText = browserText(),
  ) {
    this.listen(list, 'pointerdown', (event) => {
      this.suppressClick = false;
      const button = (event.target as Element).closest<HTMLElement>(
        '.tab-select',
      );
      if (
        !button ||
        event.button !== 0 ||
        !event.isPrimary ||
        !this.available() ||
        this.pending
      )
        return;
      const rect = button.parentElement!.getBoundingClientRect();
      this.gesture = {
        id: button.dataset.tab!,
        pointer: event.pointerId,
        start: event.clientX,
        x: event.clientX,
        y: event.clientY,
        grab: event.clientX - rect.left,
        moved: false,
        order: [...this.order],
      };
    });
    this.listen(list, 'dragstart', (event) => event.preventDefault());
    this.listen(
      list,
      'click',
      (event) => {
        if (!this.suppressClick) return;
        this.suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    this.listen(
      list,
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.gesture) {
          event.preventDefault();
          event.stopPropagation();
          this.finish(false);
          return;
        }
        if (
          !event.altKey ||
          !event.shiftKey ||
          !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
        )
          return;
        const button = (event.target as Element).closest<HTMLElement>(
          '.tab-select',
        );
        if (!button || !this.available() || this.pending || this.gesture)
          return;
        event.preventDefault();
        event.stopPropagation();
        const id = button.dataset.tab!;
        const from = this.order.indexOf(id);
        const to =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? this.order.length - 1
              : Math.max(
                  0,
                  Math.min(
                    this.order.length - 1,
                    from + (event.key === 'ArrowRight' ? 1 : -1),
                  ),
                );
        const order = this.order.filter((tab) => tab !== id);
        order.splice(to, 0, id);
        void this.commit(id, order);
      },
      true,
    );
    this.listen(
      window,
      'pointermove',
      (event) => {
        const drag = this.gesture;
        if (!drag || drag.pointer !== event.pointerId) return;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (!drag.moved && Math.abs(drag.x - drag.start) < 6) return;
        if (!drag.moved) {
          drag.moved = true;
          list.setPointerCapture(drag.pointer);
          list.classList.add('reordering');
          this.row(drag.id)?.classList.add('dragging');
          this.animation = requestAnimationFrame(() => this.paint());
        }
        event.preventDefault();
      },
      { passive: false },
    );
    this.listen(window, 'pointerup', (event) => {
      if (this.gesture?.pointer !== event.pointerId) return;
      this.gesture.x = event.clientX;
      this.gesture.y = event.clientY;
      this.finish(true);
    });
    this.listen(window, 'pointercancel', () => this.finish(false));
    this.listen(list, 'lostpointercapture', () => this.finish(false));
    this.listen(window, 'blur', () => this.finish(false));
    this.listen(window, 'resize', () => this.finish(false));
  }
  private listen<K extends keyof WindowEventMap>(
    target: HTMLElement | Window,
    name: K,
    listener: (event: WindowEventMap[K]) => void,
    options: boolean | AddEventListenerOptions = false,
  ) {
    target.addEventListener(name, listener as EventListener, {
      ...(typeof options === 'boolean' ? { capture: options } : options),
      signal: this.lifetime.signal,
    });
  }
  destroy() {
    this.cancel();
    this.lifetime.abort();
  }
  sync(order: string[]) {
    const changed =
      order.length !== this.order.length ||
      order.some((id) => !this.order.includes(id));
    this.order = order;
    if (changed) this.cancel();
    if (!this.gesture) this.layout(this.pending ?? order);
  }
  cancel() {
    this.pending = undefined;
    this.finish(false);
    this.layout(this.order);
  }
  private row(id: string) {
    return this.list.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(id)}"]`,
    );
  }
  private layout(order: string[]) {
    const focused = this.list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    order.forEach((id, index) => {
      const row = this.row(id);
      if (row && this.list.children[index] !== row)
        this.list.insertBefore(row, this.list.children[index] ?? null);
    });
    if (focused && document.activeElement !== focused)
      focused.focus({ preventScroll: true });
  }
  private paint(schedule = true) {
    const drag = this.gesture;
    const row = drag && this.row(drag.id);
    if (!drag || !row || !drag.moved) return;
    const rect = this.list.getBoundingClientRect();
    // Continue scrolling while the pointer stays at an overflowing strip's edge.
    const edge = 32;
    const speed =
      drag.x < rect.left + edge
        ? -Math.min(14, (rect.left + edge - drag.x) / 2)
        : drag.x > rect.right - edge
          ? Math.min(14, (drag.x - rect.right + edge) / 2)
          : 0;
    this.list.scrollLeft += speed;
    const nodes = this.order.map((id) => this.row(id)!);
    const first = nodes[0]!;
    const end = nodes.at(-1)!;
    const requested = drag.x - rect.left + this.list.scrollLeft - drag.grab;
    const left = Math.max(
      first.offsetLeft,
      Math.min(end.offsetLeft + end.offsetWidth - row.offsetWidth, requested),
    );
    const center = requested + row.offsetWidth / 2;
    const others = nodes.filter((node) => node !== row);
    const index = others.filter(
      (node) => node.offsetLeft + node.offsetWidth / 2 < center,
    ).length;
    drag.order = others.map((node) => node.dataset.tabId!);
    drag.order.splice(index, 0, drag.id);
    const gap =
      nodes.length > 1
        ? nodes[1]!.offsetLeft - first.offsetLeft - first.offsetWidth
        : 0;
    let target = first.offsetLeft;
    for (const id of drag.order) {
      const item = this.row(id)!;
      item.style.transform = `translateX(${(item === row ? left : target) - item.offsetLeft}px)`;
      target += item.offsetWidth + gap;
    }
    if (schedule) this.animation = requestAnimationFrame(() => this.paint());
  }
  private finish(commit: boolean) {
    const drag = this.gesture;
    if (!drag) return;
    // Pointer release can arrive before the next animation frame.
    if (commit && drag.moved) this.paint(false);
    this.gesture = undefined;
    cancelAnimationFrame(this.animation);
    if (this.list.hasPointerCapture(drag.pointer))
      this.list.releasePointerCapture(drag.pointer);
    this.list.classList.remove('reordering');
    for (const child of this.list.children) {
      (child as HTMLElement).style.transform = '';
      child.classList.remove('dragging');
    }
    if (!drag.moved) return;
    this.suppressClick = true;
    const rect = this.list.getBoundingClientRect();
    if (
      commit &&
      this.available() &&
      drag.y >= rect.top - 36 &&
      drag.y <= rect.bottom + 36
    )
      void this.commit(drag.id, drag.order);
    else this.layout(this.order);
  }
  private async commit(id: string, order: string[]) {
    if (order.every((tab, index) => tab === this.order[index])) return;
    this.pending = order;
    this.layout(order);
    const before = order[order.indexOf(id) + 1] ?? null;
    const ok = await this.move(id, before);
    if (this.pending !== order) return;
    this.pending = undefined;
    this.layout(this.order);
    this.row(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (ok)
      this.announce(
        this.text('tabs.moved', {
          position: this.order.indexOf(id) + 1,
          total: this.order.length,
        }),
      );
  }
}
