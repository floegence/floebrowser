import type { Action, BrowserState } from '../shared/protocol.js';
import type { BrowserText } from './messages.js';

const levels = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  5,
];

export class PageZoom {
  private panel = document.createElement('div');
  private less = document.createElement('button');
  private more = document.createElement('button');
  private reset = document.createElement('button');
  private lifetime = new AbortController();
  private target = '';
  private revision = 0;
  private confirmed = 1;
  private desired = 1;
  private enabled = false;
  private running = false;
  constructor(
    private button: HTMLButtonElement,
    container: HTMLElement,
    private text: BrowserText,
    private dispatch: (action: Action) => Promise<boolean>,
  ) {
    this.panel.className = 'page-zoom';
    this.panel.hidden = true;
    this.panel.id = `floe-zoom-${crypto.randomUUID()}`;
    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', text('zoom.label'));
    button.setAttribute('aria-controls', this.panel.id);
    button.setAttribute('aria-expanded', 'false');
    for (const [node, key] of [
      [this.less, 'zoom.out'],
      [this.more, 'zoom.in'],
      [this.reset, 'zoom.reset'],
    ] as const) {
      node.type = 'button';
      node.title = text(key);
      node.setAttribute('aria-label', text(key));
      node.className = 'icon-button';
    }
    this.reset.className = 'zoom-reset';
    this.less.textContent = '−';
    this.more.textContent = '+';
    this.panel.append(this.less, this.reset, this.more);
    container.append(this.panel);
    button.addEventListener(
      'click',
      () => {
        this.panel.hidden = !this.panel.hidden;
        button.setAttribute('aria-expanded', String(!this.panel.hidden));
        if (!this.panel.hidden) this.reset.focus();
      },
      { signal: this.lifetime.signal },
    );
    this.less.addEventListener('click', () => this.step(-1));
    this.more.addEventListener('click', () => this.step(1));
    this.reset.addEventListener('click', () => this.change(1));
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
    this.panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        button.focus();
      }
    });
    this.render();
  }
  state(state: BrowserState): void {
    if (state.id !== this.target) {
      this.target = state.id;
      this.revision++;
      this.running = false;
      this.close();
    }
    this.confirmed = state.zoom;
    if (!this.running) this.desired = state.zoom;
    this.render();
  }
  enable(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.close();
    this.render();
  }
  step(direction: -1 | 1): void {
    const factor =
      direction === 1
        ? levels.find((level) => level > this.desired + 0.001)
        : levels.findLast((level) => level < this.desired - 0.001);
    if (factor !== undefined) this.change(factor);
  }
  change(factor: number): void {
    if (!this.enabled) return;
    this.desired = factor;
    this.render();
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const revision = this.revision;
    while (this.enabled && this.desired !== this.confirmed) {
      const factor = this.desired;
      const ok = await this.dispatch({ kind: 'zoom', factor });
      if (revision !== this.revision) return;
      // Only a newer unsent choice may follow. Never replay a rejected or
      // unconfirmed zoom, and never reuse this intent on another tab.
      if (!ok || factor === this.desired) break;
    }
    this.running = false;
    this.desired = this.confirmed;
    this.render();
  }
  private render(): void {
    const label = this.text('zoom.percent', {
      percent: Math.round(this.desired * 100),
    });
    this.button.textContent = this.reset.textContent = label;
    this.button.disabled = this.reset.disabled = !this.enabled;
    this.less.disabled = !this.enabled || this.desired <= levels[0]!;
    this.more.disabled = !this.enabled || this.desired >= levels.at(-1)!;
  }
  close(): void {
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }
  destroy(): void {
    this.revision++;
    this.enabled = false;
    this.lifetime.abort();
    this.panel.remove();
  }
}
