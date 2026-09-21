/** Hosts supplying translations must provide the complete catalog. Source page
 * text, addresses, filenames and protocol fields are never translated here. */
export const englishMessages = {
  'tabs.list': 'Source browser tabs',
  'tabs.new': 'New tab',
  'tabs.menu': 'Tab actions',
  'tabs.pin': 'Pin tab',
  'tabs.unpin': 'Unpin tab',
  'tabs.restore': 'Reopen closed tab',
  'tabs.close': 'Close tab',
  'tabs.closeNamed': 'Close {title}',
  'tabs.moved': 'Tab moved to position {position} of {total}.',
  'navigation.label': 'Browser navigation',
  'navigation.back': 'Back',
  'navigation.forward': 'Forward',
  'navigation.reload': 'Reload',
  'navigation.reloadPage': 'Reload source page',
  'address.label': 'Website address',
  'address.placeholder': 'Search or enter an address',
  'address.suggestions': 'Address suggestions',
  'address.open': 'Open website',
  'address.go': 'Go',
  'address.switchTab': 'Switch to tab',
  'address.visited': 'Visited',
  'address.invalid': 'Enter a valid HTTP or HTTPS address, or a search term.',
  'control.take': 'Take control',
  'control.pending': 'Taking control…',
  'control.failed':
    'Control could not be transferred. Try again on the current page.',
  'status.loading': 'Loading',
  'status.live': 'Live',
  'status.connecting': 'Connecting',
  'status.disconnected': 'Disconnected',
  'connection.reconnect': 'Reconnect',
  'connection.useHere': 'Use in this window',
  'connection.otherWindow': 'This browser is open in another window',
  'connection.transferred': 'Control moved to another window',
  'connection.unavailable': 'The source browser is unavailable',
  'connection.interrupted': 'Your connection was interrupted',
  'connection.connecting': 'Connecting to your browser',
  'connection.continue':
    'Continue here with your open tabs and signed-in accounts.',
  'connection.checkSource':
    'Check that the source browser is running, then reconnect.',
  'connection.resume': 'Reconnect to continue from your current page.',
  'connection.pending': 'Your page will appear shortly.',
  'connection.version':
    'This viewer and source use different protocol versions.',
  'connection.unconfirmed':
    'Connection lost. Unconfirmed actions have not been repeated.',
  'notice.dismiss': 'Dismiss message',
  'notice.dom_limit': 'This page exceeds the DOM snapshot limit.',
  'notice.dom_update_failed':
    'A page update could not be projected. Reconnect to refresh the view.',
  'notice.popup_unavailable':
    'The website opened another source tab. Additional tabs are not projected in this version.',
  'notice.dialog_dismissed':
    'A browser dialog was dismissed. Native dialogs are not supported in DOM mode.',
  'notice.download_source_only':
    'The download was started in the source browser. File transfer is not available in this version.',
  'notice.resource_limit':
    'A page resource exceeds the projection memory limit.',
  'notice.tab_unavailable':
    'The source tab could not be opened. Try again from the current tab.',
  'page.input': 'Type in the source browser',
  'page.failed': 'This page couldn’t be loaded',
  'page.recovery':
    'Check the address and your connection, or try opening another website.',
  'page.reload': 'Reload page',
  'page.stylesSlow':
    'Some page styles took too long to load. Reload the page if it looks incomplete.',
  'action.pasteLimit': 'Paste up to 16,000 characters at a time.',
  'action.timeout':
    'This page did not confirm the action. You can switch tabs or close it. The action has not been repeated.',
  'action.stale_view':
    'The page changed before that action. Please try again on the current view.',
  'action.target_unavailable': 'The source page is unavailable.',
  'action.unsupported': 'This control is not supported in DOM mode.',
  'action.action_failed':
    'The source could not confirm that action. It has not been repeated.',
  'action.navigation_failed':
    'This page couldn’t be loaded. Check the address or try again.',
  'action.busy': 'The source is catching up. Please wait a moment.',
  'action.not_allowed': 'The host did not authorize that action.',
  'media.controls': 'Media controls',
  'media.title': 'Media',
  'media.close': 'Close media controls',
  'media.soundBlocked': 'Sound is muted — media controls',
  'media.mute': 'Mute audio',
  'media.unmute': 'Unmute audio',
  'media.seek': 'Seek source media',
  'media.showOnPage': 'Show on page',
  'media.openTab': 'Open tab',
  'media.noPlayer': 'No visible player',
  'media.audio': 'Audio',
  'media.video': 'Video',
  'media.unavailable': 'This media cannot play in this browser.',
  'media.interrupted': 'Playback interrupted. Check your connection.',
  'media.playFailed': 'Playback could not start. Try the page’s play button.',
  'media.paused': 'Paused',
  'media.playingMuted': 'Playing · Muted',
  'media.playing': 'Playing',
  'media.loading': 'Loading…',
  'media.play': 'Play',
  'media.pause': 'Pause',
  'media.playSource': 'Play source media',
  'media.pauseSource': 'Pause source media',
  'media.progress': '{elapsed} of {duration}',
  'media.canvasUnavailable': 'Canvas unavailable',
};
export type BrowserMessageKey = keyof typeof englishMessages;
export type BrowserMessages = Record<BrowserMessageKey, string>;
export type BrowserText = (
  key: BrowserMessageKey,
  values?: Record<string, string | number>,
) => string;
export function browserText(
  messages: BrowserMessages = englishMessages,
): BrowserText {
  const placeholders = (value: string) =>
    [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))]
      .sort()
      .join(',');
  for (const key of Object.keys(englishMessages) as BrowserMessageKey[]) {
    if (typeof messages[key] !== 'string' || !messages[key].trim())
      throw new Error(`Missing FloeBrowser translation: ${key}`);
    if (placeholders(messages[key]) !== placeholders(englishMessages[key]))
      throw new Error(
        `Mismatched FloeBrowser translation placeholders: ${key}`,
      );
  }
  const catalog = { ...messages };
  return (key, values = {}) =>
    catalog[key].replace(/\{(\w+)\}/g, (placeholder, name) =>
      values[name] === undefined ? placeholder : String(values[name]),
    );
}
