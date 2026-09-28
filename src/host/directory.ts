import type { SourcePage, SourceDownload } from './source.js';
import { consumePopupIntent } from './popup-intent.js';

export type SourceTab = {
  id: string;
  url: string;
  availability?: 'unsupported';
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
  /** Already captured downloads; reading this never connects a source. Changes
   * use the same directory subscription as tab metadata. */
  downloads(id: string): readonly SourceDownload[];
  subscribe(listener: (change: DirectoryChange) => void): () => void;
  /** Resolve only the requested authorized identity. A failure never removes its
   * directory entry or closes its physical page. No implicit navigation. */
  resolve(id: string): Promise<SourcePage>;
  create(): Promise<string>;
  close(id: string): Promise<void>;
  move(id: string, before: string | null): Promise<void>;
  pin(id: string, pinned: boolean): Promise<void>;
  restore(): Promise<string | undefined>;
}

/** Explicit standalone policy: own one page, its popups and newly created pages.
 * Embedding products supply their own directory instead of inheriting this grant. */
export class StandaloneSourceDirectory implements SourceDirectory {
  private entries: Array<SourceTab & { page: SourcePage }> = [];
  private listeners = new Set<(change: DirectoryChange) => void>();
  private disposers = new Map<string, () => void>();
  private closedTabs: Array<{
    url: string;
    pinned: boolean;
    position: number;
  }> = [];
  private replacing?: Promise<string>;
  private disposed = false;
  constructor(private initial: SourcePage) {
    this.add(initial);
  }
  list(): readonly SourceTab[] {
    return this.entries.map(({ page, ...entry }) => ({
      ...entry,
      url: page.url(),
    }));
  }
  downloads(id: string): readonly SourceDownload[] {
    return (
      this.entries.find((entry) => entry.id === id)?.page.downloads() ?? []
    );
  }
  async resolve(id: string): Promise<SourcePage> {
    const page = this.entries.find((entry) => entry.id === id)?.page;
    if (!page || page.isClosed()) throw new Error('Source tab is unavailable');
    return page;
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
    const entry = { page, id: page.id, url: page.url(), pinned, title: '' };
    let observedTitle = false;
    const titleChanged = (title: string) => {
      observedTitle = true;
      entry.title = title;
      this.publish();
    };
    const closed = () => {
      this.remove(page.id);
      if (!this.entries.length && !this.disposed)
        void this.replaceLast().catch(() => {});
    };
    const popup = (page: SourcePage) => {
      this.add(page);
      this.publish(
        consumePopupIntent(page) ? { activate: page.id } : undefined,
      );
    };
    const metadata = () => this.publish();
    page.on('downloadschanged', metadata);
    page.on('framenavigated', metadata);
    page.on('close', closed);
    page.on('popup', popup);
    page.on('titlechanged', titleChanged);
    this.disposers.set(page.id, () => {
      page.off('downloadschanged', metadata);
      page.off('framenavigated', metadata);
      page.off('close', closed);
      page.off('popup', popup);
      page.off('titlechanged', titleChanged);
    });
    this.entries.splice(position ?? this.entries.length, 0, entry);
    void page
      .title()
      .then((title) => {
        if (!observedTitle && this.entries.includes(entry))
          titleChanged(title.slice(0, 512));
      })
      .catch(() => {});
    this.publish();
  }
  private remove(id: string): void {
    this.disposers.get(id)?.();
    this.disposers.delete(id);
    this.entries = this.entries.filter((entry) => entry.page.id !== id);
    this.publish();
  }
  private replaceLast(): Promise<string> {
    return (this.replacing ??= this.create().finally(() => {
      this.replacing = undefined;
    }));
  }
  async create(): Promise<string> {
    if (this.disposed) throw new Error('Source directory closed');
    const page = await this.initial.createPage();
    if (this.disposed) throw new Error('Source directory closed');
    this.add(page);
    return page.id;
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
  async restore(): Promise<string | undefined> {
    const previous = this.closedTabs.pop();
    if (!previous) return;
    const page = await this.initial.createPage();
    this.add(page, previous.pinned, previous.position);
    // Only a fresh GET can be restored. No form values, POST bodies or input
    // receipts survive closure, and the source adapter creates a new target ID.
    if (/^https?:\/\//i.test(previous.url)) await page.navigate(previous.url);
    return page.id;
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
