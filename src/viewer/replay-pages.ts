// Shared by the active viewport and its hidden preparation root. Keeping these
// rules together preserves replay geometry when state-preserving moves cross
// the shadow boundary.
const projectionStyle = `
.floe-projection { position:absolute;transform-origin:top left;background:#fff;box-shadow:0 0 0 1px #00000005;box-sizing:border-box }
.floe-projection .replayer-wrapper { position:relative!important }
.floe-projection .replayer-mouse,.floe-projection .replayer-mouse-tail { display:none!important }
.floe-projection iframe { border:0!important;display:block;background:#fff }
`;

type CachedPage = {
  url: string;
  surface: HTMLElement;
  dispose: () => void;
};

/** A small cache of inert, already rendered documents. It owns no source state,
 * input authority or transport subscriptions. Moving an iframe must preserve
 * its document; engines without state-preserving moves retain only the outgoing
 * document in place until its replacement is ready. */
export class ReplayPages {
  /** Only state-preserving moves allow reuse of background documents. */
  private readonly enabled: boolean;
  private style: HTMLStyleElement;
  private parked: HTMLDivElement;
  private storage: HTMLDivElement;
  private visible?: HTMLElement;
  private pages = new Map<string, CachedPage>();
  constructor(private container: HTMLElement) {
    this.enabled = typeof container.moveBefore === 'function';
    this.style = document.createElement('style');
    this.style.textContent = projectionStyle;
    container.append(this.style);
    this.parked = document.createElement('div');
    this.parked.inert = true;
    this.parked.setAttribute('aria-hidden', 'true');
    this.parked.style.cssText =
      'position:absolute;inset:0;visibility:hidden;pointer-events:none;contain:layout paint';
    this.storage = document.createElement('div');
    // A closed root keeps parked replay documents out of host selectors while
    // preserving their iframe browsing contexts across cache moves.
    this.parked
      .attachShadow({ mode: 'closed' })
      .append(this.style.cloneNode(true), this.storage);
    // Cached frames stay connected, but outside the active viewport selector.
    // That keeps a single iframe addressable by embedded viewers while still
    // preserving the document for an instant inert preview.
    (container.parentElement ?? container).append(this.parked);
  }
  private park(surface: HTMLElement): void {
    this.storage.moveBefore(surface, null);
  }
  create(): HTMLDivElement {
    const surface = document.createElement('div');
    surface.className = 'floe-projection';
    surface.inert = true;
    surface.setAttribute('aria-hidden', 'true');
    surface.style.opacity = '0';
    surface.style.visibility = 'hidden';
    surface.style.pointerEvents = 'none';
    // A warm preview owns the visible viewport until the replacement is ready.
    // Prepare the new document offscreen without hiding or rebuilding that preview.
    if (this.enabled && this.visible) this.storage.append(surface);
    else this.container.prepend(surface);
    return surface;
  }
  present(surface: HTMLElement, interactive = true): void {
    surface.inert = !interactive;
    if (this.visible === surface) return;
    // A pending surface may never have been presented (for example when a
    // tab is previewed before its first snapshot).  Park every other active
    // surface before presenting its replacement.
    for (const child of [...this.container.children]) {
      if (
        !(child instanceof HTMLElement) ||
        !child.classList.contains('floe-projection') ||
        child === surface
      )
        continue;
      this.hide(child);
    }
    // A pending document is already attached here. Even prepending it to the
    // same parent reloads its iframe on engines without state-preserving moves.
    if (surface.parentElement !== this.container) {
      if (this.enabled)
        this.container.moveBefore(surface, this.container.firstChild);
      else this.container.prepend(surface);
    }
    surface.removeAttribute('aria-hidden');
    surface.style.opacity = '';
    surface.style.visibility = '';
    surface.style.pointerEvents = '';
    this.visible = surface;
    if (!this.enabled) {
      for (const [id, page] of this.pages)
        if (page.surface !== surface) this.drop(id);
    }
  }
  retain(
    target: string,
    url: string,
    surface: HTMLElement,
    dispose: () => void,
  ): void {
    this.drop(target);
    surface.inert = true;
    this.pages.set(target, { url, surface, dispose });
    if (this.visible !== surface) this.hide(surface);
    while (this.pages.size > 3) {
      const oldest = [...this.pages].find(
        ([, page]) => page.surface !== this.visible,
      );
      if (!oldest) break;
      this.drop(oldest[0]);
    }
  }
  preview(target: string): boolean {
    const page = this.enabled ? this.pages.get(target) : undefined;
    if (!page) {
      // A cache miss must not clear the last painted frame. It cannot accept
      // input while selection and the replacement document are pending.
      if (this.visible) this.visible.inert = true;
      return false;
    }
    this.pages.delete(target);
    this.pages.set(target, page);
    this.present(page.surface, false);
    return true;
  }
  remove(surface: HTMLElement): void {
    if (this.visible === surface) this.visible = undefined;
    surface.remove();
  }
  private hide(surface: HTMLElement): void {
    surface.inert = true;
    surface.setAttribute('aria-hidden', 'true');
    surface.style.opacity = '0';
    surface.style.visibility = 'hidden';
    surface.style.pointerEvents = 'none';
    if (this.enabled) this.park(surface);
    if (this.visible === surface) this.visible = undefined;
  }
  reconcile(tabs: { id: string; url: string; title?: string }[]): void {
    for (const [id, page] of this.pages)
      if (!tabs.some((tab) => tab.id === id && tab.url === page.url))
        this.drop(id);
  }
  drop(target: string): void {
    const page = this.pages.get(target);
    if (!page) return;
    this.pages.delete(target);
    if (this.visible === page.surface) this.visible = undefined;
    page.dispose();
    this.remove(page.surface);
  }
  clear(): void {
    for (const id of this.pages.keys()) this.drop(id);
  }
  destroy(): void {
    this.clear();
    this.parked.remove();
    this.style.remove();
  }
}
