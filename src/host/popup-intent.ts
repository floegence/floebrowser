type PopupIntent = {
  foreground: boolean;
  sequence: number;
};

const intents = new WeakMap<object, PopupIntent>();
let nextSequence = 0;

/**
 * Records the user activation that can create a popup on a source page. The
 * marker is deliberately host-local and short-lived; it is never sent over
 * the projection protocol or exposed to the website.
 */
export function markPopupIntent(source: object, foreground: boolean): number {
  const sequence = ++nextSequence;
  intents.set(source, { foreground, sequence });
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

export function forgetPopupIntentSource(source: object): void {
  intents.delete(source);
}
