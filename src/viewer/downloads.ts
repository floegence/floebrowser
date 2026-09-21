import type { Action, DownloadState, TabState } from '../shared/protocol.js';
import type { BrowserText } from './messages.js';
import { setIcon } from './icons.js';

export class Downloads {
  private panel = document.createElement('section');
  private list = document.createElement('div');
  private empty = document.createElement('p');
  private lifetime = new AbortController();
  private sources = new Map<string, DownloadState[]>();
  private directory: TabState = { active: '', tabs: [] };
  private connected = false;
  private control = false;
  private available = false;
  private saving = new Set<string>();
  private canceling = new Set<string>();
  private rows = new Map<
    string,
    {
      root: HTMLElement;
      title: HTMLElement;
      info: HTMLElement;
      save: HTMLButtonElement;
      cancel: HTMLButtonElement;
      open: HTMLButtonElement;
    }
  >();
  constructor(
    private button: HTMLButtonElement,
    container: HTMLElement,
    private text: BrowserText,
    private save: (
      target: string,
      id: string,
      signal: AbortSignal,
    ) => Promise<void>,
    private dispatch: (action: Action) => Promise<boolean>,
  ) {
    setIcon(button, 'download');
    button.setAttribute('aria-expanded', 'false');
    this.panel.className = 'downloads-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', text('downloads.title'));
    this.panel.id = `floe-downloads-${crypto.randomUUID()}`;
    button.setAttribute('aria-controls', this.panel.id);
    const header = document.createElement('header');
    const heading = document.createElement('h2');
    heading.textContent = text('downloads.title');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.setAttribute('aria-label', text('downloads.close'));
    setIcon(close, 'close');
    close.onclick = () => {
      this.close();
      button.focus();
    };
    header.append(heading, close);
    this.empty.textContent = text('downloads.empty');
    this.panel.append(header, this.empty, this.list);
    container.append(this.panel);
    button.addEventListener(
      'click',
      () => {
        this.panel.hidden = !this.panel.hidden;
        button.setAttribute('aria-expanded', String(!this.panel.hidden));
        if (!this.panel.hidden) close.focus();
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
  }
  state(target: string, items: DownloadState[]): void {
    this.sources.set(target, items);
    this.render();
  }
  tabs(tabs: TabState): void {
    this.directory = tabs;
    for (const target of this.sources.keys())
      if (!tabs.tabs.some((tab) => tab.id === target))
        this.sources.delete(target);
    this.render();
  }
  enable(connected: boolean, control: boolean, available: boolean): void {
    if (!connected && this.connected) this.sources.clear();
    this.connected = connected;
    this.control = control;
    this.available = available;
    this.button.disabled = !connected;
    if (!connected) this.close();
    this.render();
  }
  private render(): void {
    const keys = new Set<string>();
    for (const [target, files] of this.sources)
      for (const file of [...files].reverse()) {
        const key = `${target}:${file.id}`;
        keys.add(key);
        let row = this.rows.get(key);
        if (!row) {
          const root = document.createElement('article');
          root.className = 'download-row';
          const title = document.createElement('h3'),
            info = document.createElement('p');
          const actions = document.createElement('div');
          actions.className = 'download-actions';
          const save = document.createElement('button'),
            cancel = document.createElement('button'),
            open = document.createElement('button');
          for (const button of [save, cancel, open]) {
            button.type = 'button';
            button.className = 'secondary-button';
          }
          save.textContent = this.text('downloads.save');
          cancel.textContent = this.text('downloads.cancel');
          open.textContent = this.text('downloads.openTab');
          save.onclick = async () => {
            this.saving.add(key);
            save.disabled = true;
            try {
              await this.save(target, file.id, this.lifetime.signal);
            } catch {
              info.textContent = this.text('downloads.unavailable');
            } finally {
              this.saving.delete(key);
              if (root.isConnected)
                save.disabled = !this.connected || !this.available;
            }
          };
          cancel.onclick = async () => {
            this.canceling.add(key);
            cancel.disabled = true;
            await this.dispatch({ kind: 'download_cancel', download: file.id });
            this.canceling.delete(key);
            this.render();
            // The source's state update owns the result, never an optimistic cancel.
          };
          open.onclick = () =>
            void this.dispatch({ kind: 'tab_select', tab: target });
          actions.append(open, cancel, save);
          root.append(title, info, actions);
          this.list.append(root);
          row = { root, title, info, save, cancel, open };
          this.rows.set(key, row);
        }
        row.title.textContent = file.filename;
        const tab = this.directory.tabs.find((tab) => tab.id === target);
        row.info.textContent = `${tab?.title || tab?.url || ''} · ${this.text(`downloads.${file.status}`)}`;
        row.save.hidden = file.status !== 'complete';
        row.save.disabled =
          !this.connected || !this.available || this.saving.has(key);
        row.cancel.hidden = file.status !== 'receiving';
        row.cancel.disabled =
          !this.connected ||
          !this.control ||
          target !== this.directory.active ||
          this.canceling.has(key);
        row.open.hidden = target === this.directory.active;
        row.open.disabled = !this.connected;
      }
    for (const [key, row] of this.rows)
      if (!keys.has(key)) {
        row.root.remove();
        this.rows.delete(key);
      }
    this.empty.hidden = keys.size !== 0;
    this.button.classList.toggle('has-downloads', keys.size > 0);
  }
  close(): void {
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }
  destroy(): void {
    this.lifetime.abort();
    this.panel.remove();
  }
}
