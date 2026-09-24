import type { TabState } from '../shared/protocol.js';

export type AddressSuggestion = {
  title: string;
  url: string;
  tab?: string;
  bookmarked?: boolean;
};

/** Suggestions remain in this window's memory; typing never contacts a website. */
export class AddressSuggestions {
  private visits = new Map<string, AddressSuggestion>();

  remember(url: string, title: string): void {
    if (!/^https?:\/\//i.test(url)) return;
    this.visits.delete(url);
    this.visits.set(url, { url, title: title || url });
    if (this.visits.size > 100)
      this.visits.delete(this.visits.keys().next().value!);
  }

  match(query: string, tabs: TabState): AddressSuggestion[] {
    const candidates = new Map<string, AddressSuggestion>();
    for (const tab of tabs.tabs) {
      if (/^https?:\/\//i.test(tab.url))
        candidates.set(tab.url, {
          url: tab.url,
          title: tab.title || tab.url,
          tab: tab.id,
        });
    }
    for (const visit of [...this.visits.values()].reverse())
      if (!candidates.has(visit.url)) candidates.set(visit.url, visit);
    const needle = query.trim().toLocaleLowerCase();
    return [...candidates.values()]
      .filter((item) =>
        `${item.title} ${item.url}`.toLocaleLowerCase().includes(needle),
      )
      .slice(0, 6);
  }
}

export function addressURL(
  value: string,
  searchURL: (query: string) => string = (query) =>
    `https://www.google.com/search?q=${encodeURIComponent(query)}`,
): string | undefined {
  const text = value.trim();
  if (!text) return;
  const local =
    /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])(?=[:/?#]|$)/i.test(
      text,
    );
  // Scan the authority once. Overlapping repetitions on either side of a dot
  // can backtrack quadratically on a long, invalid search term.
  const authority = text.split(/[:/?#]/, 1)[0]!;
  const dot = authority.indexOf('.');
  const domain = dot > 0 && dot < authority.length - 1 && !/\s/.test(authority);
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(text) && !local && !domain;
  try {
    const url = new URL(
      !explicit && !local && !domain
        ? searchURL(text)
        : explicit
          ? text
          : `${local ? 'http' : 'https'}://${text}`,
    );
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* Invalid addresses are reported by the address bar. */
  }
}
