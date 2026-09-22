import type { BrowserState } from '../shared/protocol.js';
import type { BrowserText } from './messages.js';

export type LibraryEntry = { url: string; title: string };
export type LibraryKind = 'bookmarks' | 'history';
/** Storage and authorization belong to the embedding host. Results are bounded
 * here; typed text is never sent to a search provider. */
export interface BrowserLibrary {
  list(
    kind: LibraryKind,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly LibraryEntry[]>;
  saveBookmark(entry: LibraryEntry, signal: AbortSignal): Promise<void>;
  removeBookmark(url: string, signal: AbortSignal): Promise<void>;
  clearHistory(signal: AbortSignal): Promise<void>;
}

function website(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      raw.length <= 8192 &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export class PageLibrary {
  private panel = document.createElement('section');
  private search = document.createElement('input');
  private list = document.createElement('div');
  private status = document.createElement('p');
  private save: HTMLButtonElement;
  private clear: HTMLButtonElement;
  private confirm: HTMLButtonElement;
  private bookmarkTab: HTMLButtonElement;
  private historyTab: HTMLButtonElement;
  private kind: LibraryKind = 'bookmarks';
  private current?: LibraryEntry;
  private lifetime = new AbortController();
  private read?: AbortController;
  private busy = false;
  private navigating = false;
  private target = '';
  constructor(
    private button: HTMLButtonElement,
    container: HTMLElement,
    private text: BrowserText,
    private host: BrowserLibrary | undefined,
    private navigate: (url: string) => void,
  ) {
    button.hidden = !host;
    this.panel.className = 'browser-library';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', text('library.label'));
    this.panel.id = `floe-library-${crypto.randomUUID()}`;
    button.setAttribute('aria-controls', this.panel.id);
    button.setAttribute('aria-expanded', 'false');
    const makeButton = (key: Parameters<BrowserText>[0], run: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text(key);
      button.addEventListener('click', run);
      return button;
    };
    const header = document.createElement('header');
    this.bookmarkTab = makeButton('library.bookmarks', () =>
      this.select('bookmarks'),
    );
    this.historyTab = makeButton('library.history', () =>
      this.select('history'),
    );
    header.append(
      this.bookmarkTab,
      this.historyTab,
      makeButton('library.close', () => {
        this.close();
        button.focus();
      }),
    );
    this.search.type = 'search';
    this.search.maxLength = 8192;
    this.search.placeholder = text('library.search');
    this.search.setAttribute('aria-label', text('library.search'));
    this.search.addEventListener('input', () => {
      this.confirm.hidden = true;
      void this.refresh();
    });
    this.save = makeButton('library.save', () => {
      const entry = this.current;
      if (entry)
        void this.mutate(() => host!.saveBookmark(entry, this.lifetime.signal));
    });
    this.clear = makeButton('library.clear', () => {
      this.confirm.hidden = false;
      this.confirm.focus();
    });
    this.confirm = makeButton(
      'library.confirmClear',
      () => void this.mutate(() => host!.clearHistory(this.lifetime.signal)),
    );
    this.confirm.hidden = true;
    this.status.setAttribute('role', 'status');
    this.list.className = 'browser-library-entries';
    this.panel.append(
      header,
      this.search,
      this.save,
      this.clear,
      this.confirm,
      this.status,
      this.list,
    );
    container.append(this.panel);
    button.addEventListener(
      'click',
      () => {
        if (!this.panel.hidden) {
          this.close();
          return;
        }
        this.panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        this.search.focus();
        this.select(this.kind);
      },
      { signal: this.lifetime.signal },
    );
    this.panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
      button.focus();
    });
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (
          !this.panel.contains(event.target as Node) &&
          !button.contains(event.target as Node)
        )
          this.close();
      },
      { signal: this.lifetime.signal },
    );
    this.controls();
  }
  state(state: BrowserState): void {
    this.target = state.id;
    this.current = website(state.url)
      ? { url: state.url, title: state.title.slice(0, 512) }
      : undefined;
    this.controls();
  }
  selected(target: string): void {
    if (this.target === target) return;
    this.current = undefined;
    this.controls();
  }
  enableNavigation(enabled: boolean): void {
    this.navigating = enabled;
    for (const button of this.list.querySelectorAll<HTMLButtonElement>(
      '[data-library-open]',
    ))
      button.disabled = !enabled;
  }
  private controls(): void {
    this.save.disabled = !this.current || this.busy;
    this.clear.disabled = this.confirm.disabled = this.busy;
    this.save.hidden = this.kind !== 'bookmarks';
    this.clear.hidden = this.kind !== 'history';
    this.bookmarkTab.setAttribute(
      'aria-pressed',
      String(this.kind === 'bookmarks'),
    );
    this.historyTab.setAttribute(
      'aria-pressed',
      String(this.kind === 'history'),
    );
  }
  private select(kind: LibraryKind): void {
    this.kind = kind;
    this.confirm.hidden = true;
    this.controls();
    void this.refresh();
  }
  private async refresh(): Promise<void> {
    this.read?.abort();
    if (!this.host || this.panel.hidden) return;
    const read = (this.read = new AbortController());
    const signal = AbortSignal.any([read.signal, this.lifetime.signal]);
    const kind = this.kind;
    this.status.textContent = this.text('library.loading');
    this.list.replaceChildren();
    try {
      const entries = await this.host.list(kind, this.search.value, signal);
      if (signal.aborted) return;
      const fragment = document.createDocumentFragment();
      for (const entry of entries.slice(0, 100)) {
        if (
          typeof entry.url !== 'string' ||
          typeof entry.title !== 'string' ||
          !website(entry.url)
        )
          continue;
        const row = document.createElement('div'),
          open = document.createElement('button');
        const title = document.createElement('strong'),
          url = document.createElement('small');
        title.textContent = entry.title.slice(0, 512) || entry.url;
        url.textContent = entry.url;
        open.type = 'button';
        open.dataset.libraryOpen = '';
        open.disabled = !this.navigating;
        open.append(title, document.createTextNode(' '), url);
        open.addEventListener('click', () => {
          if (!this.navigating) return;
          this.close();
          this.navigate(entry.url);
        });
        row.append(open);
        if (kind === 'bookmarks') {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '×';
          remove.setAttribute(
            'aria-label',
            this.text('library.remove', { title: title.textContent }),
          );
          remove.disabled = this.busy;
          remove.addEventListener(
            'click',
            () =>
              void this.mutate(() =>
                this.host!.removeBookmark(entry.url, this.lifetime.signal),
              ),
          );
          row.append(remove);
        }
        fragment.append(row);
      }
      this.status.textContent = fragment.childElementCount
        ? ''
        : this.text('library.empty');
      this.list.replaceChildren(fragment);
    } catch {
      if (!signal.aborted)
        this.status.textContent = this.text('library.failed');
    }
  }
  private async mutate(work: () => Promise<void>): Promise<void> {
    if (this.busy || this.lifetime.signal.aborted) return;
    this.busy = true;
    this.controls();
    this.confirm.hidden = true;
    try {
      await work();
      if (!this.lifetime.signal.aborted) void this.refresh();
    } catch {
      if (!this.lifetime.signal.aborted)
        this.status.textContent = this.text('library.failed');
    } finally {
      this.busy = false;
      if (!this.lifetime.signal.aborted) this.controls();
    }
  }
  close(): void {
    this.panel.hidden = true;
    this.confirm.hidden = true;
    this.read?.abort();
    this.button.setAttribute('aria-expanded', 'false');
  }
  destroy(): void {
    this.close();
    this.lifetime.abort();
    this.panel.remove();
  }
}
