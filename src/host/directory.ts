import type { SourcePage } from './source.js';

export type SourceTab = {
  page: SourcePage;
  title?: string;
  pinned?: boolean;
  loading?: boolean;
};
export type DirectoryChange = { activate?: string };

/** Authoritative host-granted page directory. Mutations must publish the resulting
 * directory before resolving. Removing a grant revokes projection immediately;
 * it need not close the physical page. Never include ungranted personal tabs. */
export interface SourceDirectory {
  list(): readonly SourceTab[];
  subscribe(listener: (change: DirectoryChange) => void): () => void;
  create(): Promise<SourcePage>;
  close(id: string): Promise<void>;
  move(id: string, before: string | null): Promise<void>;
  pin(id: string, pinned: boolean): Promise<void>;
  restore(): Promise<SourcePage | undefined>;
}

/** Explicit standalone policy: own one page, its popups and newly created pages.
 * Embedding products supply their own directory instead of inheriting this grant. */
export class StandaloneSourceDirectory implements SourceDirectory {
  private entries: SourceTab[] = [];
  private listeners = new Set<(change: DirectoryChange) => void>();
  private disposers = new Map<string, () => void>();
  private closedTabs: Array<{
    url: string;
    pinned: boolean;
    position: number;
  }> = [];
  private replacing?: Promise<SourcePage>;
  private disposed = false;
  constructor(private initial: SourcePage) {
    this.add(initial);
  }
  list(): readonly SourceTab[] {
    return this.entries;
  }
  subscribe(listener: (change: DirectoryChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(change: DirectoryChange = {}) {
    if (!this.disposed) for (const listener of this.listeners) listener(change);
  }
  private add(page: SourcePage, pinned = false, position?: number): void {
    if (
      this.disposed ||
      this.entries.some((entry) => entry.page.id === page.id)
    )
      return;
    if (page.isClosed()) throw new Error('Source tab is closed');
    const closed = () => {
      this.remove(page.id);
      if (!this.entries.length && !this.disposed)
        void this.replaceLast().catch(() => {});
    };
    const popup = (page: SourcePage) => {
      this.add(page);
      this.publish({ activate: page.id });
    };
    page.on('close', closed);
    page.on('popup', popup);
    this.disposers.set(page.id, () => {
      page.off('close', closed);
      page.off('popup', popup);
    });
    this.entries.splice(position ?? this.entries.length, 0, { page, pinned });
    this.publish();
  }
  private remove(id: string): void {
    this.disposers.get(id)?.();
    this.disposers.delete(id);
    this.entries = this.entries.filter((entry) => entry.page.id !== id);
    this.publish();
  }
  private replaceLast(): Promise<SourcePage> {
    return (this.replacing ??= this.create().finally(() => {
      this.replacing = undefined;
    }));
  }
  async create(): Promise<SourcePage> {
    if (this.disposed) throw new Error('Source directory closed');
    const page = await this.initial.createPage();
    if (this.disposed) throw new Error('Source directory closed');
    this.add(page);
    return page;
  }
  async close(id: string): Promise<void> {
    const position = this.entries.findIndex((entry) => entry.page.id === id);
    const entry = this.entries[position];
    if (!entry) throw new Error('Unknown source tab');
    const url = entry.page.url();
    await entry.page.close();
    if (!entry.page.isClosed()) return; // A beforeunload confirmation may cancel.
    this.remove(id);
    this.closedTabs.push({ url, pinned: !!entry.pinned, position });
    if (this.closedTabs.length > 25) this.closedTabs.shift();
    if (!this.entries.length) await this.replaceLast();
    else if (this.replacing) await this.replacing;
  }
  async move(id: string, before: string | null): Promise<void> {
    const item = this.entries.find((entry) => entry.page.id === id);
    if (
      !item ||
      (before !== null &&
        !this.entries.some((entry) => entry.page.id === before))
    )
      throw new Error('Unknown source tab');
    if (id === before) return;
    const others = this.entries.filter((entry) => entry !== item);
    const index =
      before === null
        ? others.length
        : others.findIndex((entry) => entry.page.id === before);
    others.splice(index, 0, item);
    this.entries = others;
    this.publish();
  }
  async pin(id: string, pinned: boolean): Promise<void> {
    const entry = this.entries.find((entry) => entry.page.id === id);
    if (!entry) throw new Error('Unknown source tab');
    this.entries = this.entries.map((item) =>
      item === entry ? { ...item, pinned } : item,
    );
    this.publish();
  }
  async restore(): Promise<SourcePage | undefined> {
    const previous = this.closedTabs.pop();
    if (!previous) return;
    const page = await this.initial.createPage();
    this.add(page, previous.pinned, previous.position);
    // Only a fresh GET can be restored. No form values, POST bodies or input
    // receipts survive closure, and the source adapter creates a new target ID.
    if (/^https?:\/\//i.test(previous.url)) await page.navigate(previous.url);
    return page;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers.values()) dispose();
    this.disposers.clear();
    this.listeners.clear();
    this.closedTabs.length = 0;
  }
}
