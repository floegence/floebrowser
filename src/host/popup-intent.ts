type PopupIntent = {
  foreground: boolean;
  sequence: number;
};

const intents = new WeakMap<object, PopupIntent>();
const trackedSources = new Set<object>();
let nextSequence = 0;

/**
 * Records the user activation that can create a popup on a source page. The
 * marker is deliberately host-local and short-lived; it is never sent over
 * the projection protocol or exposed to the website.
 */
export function markPopupIntent(source: object, foreground: boolean): number {
  const sequence = ++nextSequence;
  intents.set(source, { foreground, sequence });
  trackedSources.add(source);
  return sequence;
}

export function clearPopupIntent(source: object, sequence: number): void {
  if (intents.get(source)?.sequence === sequence) intents.delete(source);
}

/**
 * A popup without a recent pointer activation (for example a keyboard or
 * script action) stays in the directory without stealing the current view.
 */
export function consumePopupIntent(source: object): boolean {
  const intent = intents.get(source);
  if (!intent) return true;
  intents.delete(source);
  return intent.foreground;
}

/**
 * Middle-click opens a new Chromium page without an opener relationship, so
 * Playwright reports only the browser-context `page` event. Resolve that page
 * against the newest source-side pointer intent while it is still fresh.
 */
export function consumeLatestPopupIntent(
  candidates?: ReadonlySet<object>,
): { source: object; foreground: boolean } | undefined {
  let selected: { source: object; intent: PopupIntent } | undefined;
  for (const source of trackedSources) {
    if (candidates && !candidates.has(source)) continue;
    const intent = intents.get(source);
    if (intent && (!selected || intent.sequence > selected.intent.sequence))
      selected = { source, intent };
  }
  if (!selected) return undefined;
  intents.delete(selected.source);
  return { source: selected.source, foreground: selected.intent.foreground };
}

export function forgetPopupIntentSource(source: object): void {
  intents.delete(source);
  trackedSources.delete(source);
}
