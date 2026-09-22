import type { Action, BrowserState } from '../shared/protocol.js';

export interface ZoomPreferences {
  load(origin: string, signal: AbortSignal): Promise<number>;
  save(origin: string, factor: number, signal: AbortSignal): Promise<void>;
}

/** Restores only for the current controller. A pending preference read loses to
 * navigation, takeover and a newer explicit zoom; it never replays an action. */
export class OriginZoom {
  private current?: { target: string; origin: string; zoom: number };
  private allowed = false;
  private consumed = '';
  private read?: AbortController;
  private lifetime = new AbortController();
  constructor(
    private host: ZoomPreferences | undefined,
    private dispatch: (action: Action) => Promise<boolean>,
    private failed: () => void,
  ) {}
  state(state: BrowserState): void {
    let origin = '';
    try {
      const url = new URL(state.url);
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        origin = url.origin;
    } catch {
      /* Non-website pages have no persisted preference. */
    }
    const before = this.key();
    this.current = origin
      ? { target: state.id, origin, zoom: state.zoom }
      : undefined;
    if (before !== this.key()) {
      this.read?.abort();
      this.consumed = '';
    }
    this.restore();
  }
  enable(allowed: boolean): void {
    if (this.allowed === allowed) return;
    this.allowed = allowed;
    if (!allowed) {
      this.read?.abort();
      this.consumed = '';
    }
    this.restore();
  }
  private key(): string {
    return this.current ? `${this.current.target}\n${this.current.origin}` : '';
  }
  private restore(): void {
    const key = this.key(),
      current = this.current;
    if (
      !this.host ||
      !this.allowed ||
      !current ||
      !key ||
      key === this.consumed ||
      this.lifetime.signal.aborted
    )
      return;
    this.consumed = key;
    const read = (this.read = new AbortController());
    const signal = AbortSignal.any([read.signal, this.lifetime.signal]);
    void this.host
      .load(current.origin, signal)
      .then(async (factor) => {
        if (signal.aborted || !this.allowed || this.key() !== key) return;
        if (!Number.isFinite(factor) || factor < 0.25 || factor > 5)
          throw new Error('Invalid zoom preference');
        if (factor !== this.current!.zoom)
          await this.dispatch({ kind: 'zoom', factor });
      })
      .catch(() => {
        if (!signal.aborted) this.failed();
      });
  }
  async change(action: Action): Promise<boolean> {
    const key = this.key(),
      current = this.current;
    this.read?.abort();
    this.consumed = key;
    const ok = await this.dispatch(action);
    if (
      ok &&
      action.kind === 'zoom' &&
      current &&
      this.key() === key &&
      this.host &&
      !this.lifetime.signal.aborted
    ) {
      try {
        await this.host.save(
          current.origin,
          action.factor,
          this.lifetime.signal,
        );
      } catch {
        if (!this.lifetime.signal.aborted) this.failed();
      }
    }
    return ok;
  }
  destroy(): void {
    this.lifetime.abort();
    this.read?.abort();
  }
}
