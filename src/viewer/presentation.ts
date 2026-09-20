type DocumentView = {
  styles: Set<HTMLStyleElement | HTMLLinkElement>;
  failed: WeakMap<Node, { sheet: CSSStyleSheet | null; text: string | null }>;
  curtain?: HTMLStyleElement;
  root?: Element;
  frame: number;
  timer?: ReturnType<typeof setTimeout>;
  complete: boolean;
  dispose: () => void;
};

function loading(sheet: CSSStyleSheet | null): boolean {
  if (!sheet) return true;
  try {
    for (const rule of sheet.cssRules) {
      if (
        rule.type === CSSRule.IMPORT_RULE &&
        loading((rule as CSSImportRule).styleSheet)
      )
        return true;
    }
  } catch {
    // An inaccessible sheet has completed loading; it cannot be inspected.
  }
  return false;
}

/** Prepare each rebuilt document before exposing it, including late iframe DOM. */
export class ReplayPresentation {
  private documents = new WeakMap<Document, DocumentView>();
  private pending = new Set<DocumentView>();
  private started = false;
  private disposed = false;
  private presented = false;
  private warned = false;

  constructor(
    private ready: () => void,
    private timeout: () => void,
  ) {}

  get active(): boolean {
    return !this.disposed;
  }

  build(node: Node): void {
    const document =
      node.nodeType === 9 ? (node as Document) : node.ownerDocument;
    if (!document || this.disposed) return;
    let view = this.documents.get(document);
    if (view?.root && view.root !== document.documentElement) {
      this.release(view);
      view = undefined;
    }
    if (!view) {
      view = {
        styles: new Set(),
        failed: new WeakMap(),
        frame: 0,
        complete: false,
        dispose: () => {},
      };
      this.documents.set(document, view);
    }
    if (view.complete) return;
    if (node.nodeName === 'STYLE' || node.nodeName === 'LINK')
      view.styles.add(node as HTMLStyleElement | HTMLLinkElement);
    if (node.nodeType !== 9 || view.curtain || !document.documentElement)
      return;
    const failed = (event: Event) => {
      const node = event.target as HTMLStyleElement | HTMLLinkElement | null;
      if (node?.nodeName === 'STYLE' || node?.nodeName === 'LINK')
        view.failed.set(node, { sheet: node.sheet, text: node.textContent });
    };
    document.addEventListener('error', failed, true);
    view.dispose = () => document.removeEventListener('error', failed, true);
    const curtain = document.createElement('style');
    // Opacity preserves layout, font loading and animations while hiding every
    // descendant, including children with their own visibility declarations.
    curtain.textContent =
      ':root { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }';
    (document.head ?? document.documentElement).append(curtain);
    view.curtain = curtain;
    view.root = document.documentElement;
    this.pending.add(view);
    let stable = 0;
    let fontsUntil = Infinity;
    const check = () => {
      if (this.disposed || view.complete) return;
      const pending = [...view.styles].some((node) => {
        if (
          !node.isConnected ||
          node.disabled ||
          (node.type && node.type !== 'text/css')
        )
          return false;
        const failed = view.failed.get(node);
        if (
          failed &&
          failed.sheet === node.sheet &&
          failed.text === node.textContent
        )
          return false;
        if (
          node.nodeName === 'LINK' &&
          !(node as HTMLLinkElement).relList.contains('stylesheet')
        )
          return false;
        if (node.media && !document.defaultView?.matchMedia(node.media).matches)
          return false;
        return loading(node.sheet);
      });
      // Force style/layout before checking fonts; a new stylesheet may have
      // introduced a font that the browser has not requested yet.
      void document.documentElement?.offsetHeight;
      if (pending) fontsUntil = Infinity;
      else if (fontsUntil === Infinity) fontsUntil = performance.now() + 200;
      stable =
        !pending &&
        (document.fonts.status === 'loaded' || performance.now() >= fontsUntil)
          ? stable + 1
          : 0;
      if (stable >= 2) this.finish(view);
      else view.frame = requestAnimationFrame(check);
    };
    view.timer = setTimeout(() => {
      if (!this.warned) {
        this.warned = true;
        this.timeout();
      }
      this.finish(view);
    }, 10000);
    view.frame = requestAnimationFrame(check);
  }

  start(): void {
    this.started = true;
    this.present();
  }

  private finish(view: DocumentView): void {
    this.release(view);
    this.present();
  }

  private release(view: DocumentView): void {
    view.complete = true;
    clearTimeout(view.timer);
    cancelAnimationFrame(view.frame);
    view.dispose();
    view.curtain?.remove();
    view.styles.clear();
    this.pending.delete(view);
  }

  private present(): void {
    if (this.disposed || !this.started || this.presented) return;
    if (this.pending.size) return;
    this.presented = true;
    this.ready();
  }

  dispose(): void {
    this.disposed = true;
    for (const view of this.pending) this.release(view);
  }
}
