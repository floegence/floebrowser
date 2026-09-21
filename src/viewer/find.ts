import type { Action } from '../shared/protocol.js';
import type { BrowserText } from './messages.js';
import { setIcon } from './icons.js';

export class PageFind {
  private root = document.createElement('form');
  private input = document.createElement('input');
  private status = document.createElement('span');
  private previous = document.createElement('button');
  private next = document.createElement('button');
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private restore?: HTMLElement;
  constructor(
    container: HTMLElement,
    private text: BrowserText,
    private dispatch: (action: Action) => Promise<boolean>,
  ) {
    this.root.className = 'page-find';
    this.root.hidden = true;
    this.root.setAttribute('role', 'search');
    this.root.setAttribute('aria-label', text('find.label'));
    this.input.type = 'search';
    this.input.maxLength = 512;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', text('find.label'));
    this.input.placeholder = text('find.label');
    this.status.setAttribute('role', 'status');
    this.status.className = 'find-result';
    const close = document.createElement('button');
    for (const [button, key, icon] of [
      [this.previous, 'find.previous', 'up'],
      [this.next, 'find.next', 'down'],
      [close, 'find.close', 'close'],
    ] as const) {
      button.type = 'button';
      button.className = 'icon-button';
      button.title = text(key);
      button.setAttribute('aria-label', text(key));
      setIcon(button, icon);
    }
    this.root.append(this.input, this.status, this.previous, this.next, close);
    container.append(this.root);
    this.input.addEventListener('input', (event) => {
      clearTimeout(this.timer);
      this.status.textContent = '';
      if ((event as InputEvent).isComposing) return;
      if (!this.input.matches(':focus') || this.input.value === '') return;
      this.timer = setTimeout(() => this.run(false, true), 120);
    });
    this.input.addEventListener('compositionstart', () =>
      clearTimeout(this.timer),
    );
    this.input.addEventListener('compositionend', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(false, true), 120);
    });
    this.root.addEventListener('submit', (event) => {
      event.preventDefault();
      this.run(false, false);
    });
    this.root.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.run(event.shiftKey, false);
      }
    });
    this.previous.addEventListener('click', () => this.run(true, false));
    this.next.addEventListener('click', () => this.run(false, false));
    close.addEventListener('click', () => this.close());
  }
  open(): void {
    if (!this.enabled) return;
    if (this.root.hidden) this.restore = document.activeElement as HTMLElement;
    this.root.hidden = false;
    this.input.focus();
    this.input.select();
  }
  close(): void {
    clearTimeout(this.timer);
    const restore = this.root.contains(document.activeElement);
    this.root.hidden = true;
    this.status.textContent = '';
    if (restore && this.restore?.isConnected)
      this.restore.focus({ preventScroll: true });
    this.restore = undefined;
  }
  enable(enabled: boolean): void {
    this.enabled = enabled;
    this.input.disabled =
      this.previous.disabled =
      this.next.disabled =
        !enabled;
    if (!enabled) clearTimeout(this.timer);
  }
  result(result: { query: string; found: boolean }): void {
    if (this.root.hidden || this.input.value !== result.query) return;
    this.status.textContent = result.found ? '' : this.text('find.none');
  }
  private run(backwards: boolean, restart: boolean): void {
    clearTimeout(this.timer);
    if (!this.enabled || !this.input.value || this.root.hidden) return;
    void this.dispatch({
      kind: 'find',
      query: this.input.value,
      backwards,
      restart,
    });
  }
  destroy(): void {
    this.close();
    this.root.remove();
  }
}
