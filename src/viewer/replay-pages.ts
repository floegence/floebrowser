type CachedPage = {
  url: string;
  title: string;
  surface: HTMLElement;
  dispose: () => void;
};

/** A small cache of inert, already rendered documents. It owns no source state,
 * input authority or transport subscriptions. Moving an iframe must preserve
 * its document; engines without state-preserving moves simply rebuild pages. */
export class ReplayPages {
  /** Engines with moveBefore preserve a cached document when it is moved in
   * the active viewport.  Surfaces remain in the light DOM while pending so
   * embedders can observe their iframe and inert DOM before presentation. */
  readonly enabled: boolean;
  private parked: HTMLDivElement;
  private storage: HTMLDivElement;
  private visible?: HTMLElement;
  private pages = new Map<string, CachedPage>();
  constructor(private container: HTMLElement) {
    this.enabled = typeof container.moveBefore === 'function';
    this.parked = document.createElement('div');
    this.parked.inert = true;
    this.parked.setAttribute('aria-hidden', 'true');
    this.parked.style.cssText =
      'position:absolute;inset:0;visibility:hidden;pointer-events:none;contain:layout paint';
    this.storage = document.createElement('div');
    // A closed root keeps parked replay documents out of host selectors while
    // preserving their iframe browsing contexts across cache moves.
    this.parked.attachShadow({ mode: 'closed' }).append(this.storage);
    // Cached frames stay connected, but outside the active viewport selector.
    // That keeps a single iframe addressable by embedded viewers while still
    // preserving the document for an instant inert preview.
    (container.parentElement ?? container).append(this.parked);
  }
  private park(surface: HTMLElement): void {
    if (this.enabled) this.storage.moveBefore(surface, null);
    else this.storage.append(surface);
  }
  create(): HTMLDivElement {
    // A source resync can race a cached preview.  Keep the new active surface
    // as the only iframe under the viewport so host selectors have one stable
    // target while the new document is preparing.
    for (const child of [...this.container.children]) {
      if (
        !(child instanceof HTMLElement) ||
        !child.classList.contains('floe-projection')
      )
        continue;
      child.inert = true;
      child.setAttribute('aria-hidden', 'true');
      child.style.opacity = '0';
      child.style.visibility = 'hidden';
      child.style.pointerEvents = 'none';
      this.park(child);
      if (this.visible === child) this.visible = undefined;
    }
    const surface = document.createElement('div');
    surface.className = 'floe-projection';
    surface.inert = true;
    surface.setAttribute('aria-hidden', 'true');
    surface.style.opacity = '0';
    surface.style.visibility = 'hidden';
    surface.style.pointerEvents = 'none';
    // Keep pending documents connected in the light DOM.  This preserves the
    // iframe/contentDocument contract for embedders while the presentation
    // curtain controls visibility and input authority.
    this.container.append(surface);
    return surface;
  }
  present(surface: HTMLElement): void {
    if (this.visible === surface) return;
    // A pending surface may never have been presented (for example when a
    // tab is previewed before its first snapshot).  Park every other active
    // surface so the viewport always exposes one iframe to its host.
    for (const child of [...this.container.children]) {
      if (
        !(child instanceof HTMLElement) ||
        !child.classList.contains('floe-projection') ||
        child === surface
      )
        continue;
      child.inert = true;
      child.setAttribute('aria-hidden', 'true');
      child.style.opacity = '0';
      child.style.visibility = 'hidden';
      child.style.pointerEvents = 'none';
      this.park(child);
    }
    if (this.enabled)
      this.container.moveBefore(surface, this.container.firstChild);
    else this.container.prepend(surface);
    surface.inert = false;
    surface.removeAttribute('aria-hidden');
    surface.style.opacity = '';
    surface.style.visibility = '';
    surface.style.pointerEvents = '';
    this.visible = surface;
  }
  retain(
    target: string,
    url: string,
    title: string,
    surface: HTMLElement,
    dispose: () => void,
  ): void {
    this.drop(target);
    surface.inert = true;
    surface.setAttribute('aria-hidden', 'true');
    surface.style.opacity = '0';
    surface.style.visibility = 'hidden';
    surface.style.pointerEvents = 'none';
    this.pages.set(target, { url, title, surface, dispose });
    if (this.visible === surface) {
      this.visible = undefined;
      this.park(surface);
    }
    while (this.pages.size > 3) this.drop(this.pages.keys().next().value!);
  }
  preview(target: string): boolean {
    const page = this.pages.get(target);
    if (!page) return false;
    this.pages.delete(target);
    this.pages.set(target, page);
    this.present(page.surface);
    return true;
  }
  reconcile(tabs: { id: string; url: string; title?: string }[]): void {
    for (const [id, page] of this.pages)
      if (
        !tabs.some(
          (tab) =>
            tab.id === id &&
            tab.url === page.url &&
            (tab.title ?? tab.url) === page.title,
        )
      )
        this.drop(id);
  }
  drop(target: string): void {
    const page = this.pages.get(target);
    if (!page) return;
    this.pages.delete(target);
    if (this.visible === page.surface) this.visible = undefined;
    page.dispose();
    page.surface.remove();
  }
  clear(): void {
    for (const id of this.pages.keys()) this.drop(id);
  }
  destroy(): void {
    this.clear();
    this.parked.remove();
  }
}
