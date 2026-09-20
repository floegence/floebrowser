import './viewer.css';
import { DOMBrowserView, webSocketConnection } from './client.js';
import {
  AddressSuggestions,
  addressURL,
  type AddressSuggestion,
} from './address.js';
import type { Action, TabState } from '../shared/protocol.js';

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const address = element<HTMLInputElement>('address');
const overlay = element('connection-overlay');
const welcome = element('welcome');
const viewport = element('viewport');
const stage = viewport.parentElement!;
const suggestions = new AddressSuggestions();
const suggestionList = element('address-suggestions');
let matches: AddressSuggestion[] = [];
let selectedSuggestion = -1;
let composing = false;
let addressEditing = false;
let view: DOMBrowserView | undefined;
let sourceURL = 'about:blank';
let sourceID = '';
let tabState: TabState = { active: '', tabs: [] };
let connected = false;
let ready = false;
let changingTab = false;
let canGoBack = false;
let canGoForward = false;
let offerTakeover = false;
let toastTimer: ReturnType<typeof setTimeout>;
// Only unsent tab selections are replaceable. Submitted effects are never replayed.
type ChromeCommand = { action: Action; resolve: (ok: boolean) => void };
const commands: ChromeCommand[] = [];
let current: ChromeCommand | undefined;
const rows = new Map<
  string,
  { row: HTMLElement; select: HTMLButtonElement; close: HTMLButtonElement }
>();

function notice(message: string): void {
  element('toast-message').textContent = message;
  element('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element('toast').hidden = true;
  }, 9000);
}
function desiredTab(): string {
  const selection = [...(current ? [current] : []), ...commands].findLast(
    (command) => command.action.kind === 'tab_select',
  );
  return selection?.action.kind === 'tab_select'
    ? selection.action.tab
    : tabState.active;
}
function switching(): boolean {
  return (
    changingTab ||
    [current, ...commands].some(
      (command) =>
        command &&
        (command.action.kind === 'tab_select' ||
          command.action.kind === 'tab_new' ||
          (command.action.kind === 'tab_close' &&
            command.action.tab === tabState.active)),
    )
  );
}
function updateChrome(): void {
  const selected = desiredTab();
  const pending = switching();
  stage.classList.toggle('switching', connected && pending);
  viewport.inert = !connected || !ready || pending;
  for (const [id, item] of rows) {
    item.row.classList.toggle('active', id === selected);
    item.select.setAttribute('aria-selected', String(id === selected));
    item.select.tabIndex = id === selected ? 0 : -1;
    item.select.disabled = item.close.disabled = !connected;
  }
  element<HTMLButtonElement>('new-tab').disabled = !connected;
  element<HTMLButtonElement>('back').disabled =
    !connected || pending || !canGoBack;
  element<HTMLButtonElement>('forward').disabled =
    !connected || pending || !canGoForward;
  element<HTMLButtonElement>('reload').disabled = !connected || pending;
  address.disabled = !connected;
  element<HTMLButtonElement>('address-go').disabled = !connected;
  const target = tabState.tabs.find((tab) => tab.id === selected);
  welcome.hidden = !connected || pending || target?.url !== 'about:blank';
}
function command(action: Action): Promise<boolean> {
  if (!connected) return Promise.resolve(false);
  return new Promise((resolve) => {
    const tail = commands.at(-1);
    if (action.kind === 'tab_select' && tail?.action.kind === 'tab_select') {
      commands.pop()!.resolve(false);
    }
    commands.push({ action, resolve });
    updateChrome();
    void drain();
  });
}
async function drain(): Promise<void> {
  if (current) return;
  while (connected && commands.length) {
    const work = commands.shift()!;
    current = work;
    updateChrome();
    if (!work.action.kind.startsWith('tab_')) {
      // Dispatch in intent order, but page completion never holds browser
      // chrome. A subsequent tab command can revoke this page immediately.
      void view!.dispatch(work.action).then(work.resolve);
      current = undefined;
      continue;
    }
    const ok =
      work.action.kind === 'tab_select' && work.action.tab === tabState.active
        ? true
        : await view!.dispatch(work.action);
    work.resolve(ok);
    current = undefined;
    if (!ok) {
      for (const pending of commands.splice(0)) pending.resolve(false);
      break;
    }
  }
  updateChrome();
  if (document.activeElement !== address) setAddress();
}
function setAddress(): void {
  const target = tabState.tabs.find((tab) => tab.id === desiredTab());
  const url = target?.url ?? sourceURL;
  address.value = url === 'about:blank' ? '' : url;
}
function closingTab(id: string): boolean {
  return [current, ...commands].some(
    (command) =>
      command?.action.kind === 'tab_close' && command.action.tab === id,
  );
}
function selectTab(id: string): void {
  if (closingTab(id)) return;
  if (id === desiredTab()) {
    setAddress();
    return;
  }
  addressEditing = false;
  hideSuggestions();
  void command({ kind: 'tab_select', tab: id });
  setAddress();
  rows.get(id)?.select.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
async function closeTab(id: string): Promise<void> {
  if (closingTab(id)) return;
  const focused = rows.get(id)?.row.contains(document.activeElement);
  const wasActive = id === desiredTab();
  if (await command({ kind: 'tab_close', tab: id })) {
    if (
      (focused || wasActive) &&
      tabState.tabs.find((tab) => tab.id === tabState.active)?.url ===
        'about:blank'
    )
      focusAddress();
    else if (focused || wasActive) rows.get(desiredTab())?.select.focus();
  }
}
function renderTabs(state: TabState): void {
  const previous = tabState.active;
  if (previous && previous !== state.active) {
    changingTab = true;
    clearTimeout(toastTimer);
    element('toast').hidden = true;
  }
  tabState = state;
  const list = element('tabs');
  const focusedTab = document.activeElement?.getAttribute('data-tab');
  for (const [id, item] of rows) {
    if (!state.tabs.some((tab) => tab.id === id)) {
      item.row.remove();
      rows.delete(id);
    }
  }
  state.tabs.forEach((tab, index) => {
    let item = rows.get(tab.id);
    if (!item) {
      const row = document.createElement('div');
      row.className = 'tab';
      const select = document.createElement('button');
      select.className = 'tab-select';
      select.setAttribute('role', 'tab');
      select.dataset.tab = tab.id;
      select.addEventListener('click', () => selectTab(tab.id));
      select.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
          return;
        event.preventDefault();
        const i = tabState.tabs.findIndex((item) => item.id === tab.id);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabState.tabs.length - 1
              : (i +
                  (event.key === 'ArrowRight' ? 1 : -1) +
                  tabState.tabs.length) %
                tabState.tabs.length;
        const id = tabState.tabs[next]!.id;
        selectTab(id);
        rows.get(id)?.select.focus();
      });
      row.addEventListener('mousedown', (event) => {
        if (event.button === 1) event.preventDefault();
      });
      row.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        void closeTab(tab.id);
      });
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.title = 'Close tab';
      close.textContent = '×';
      close.addEventListener('click', () => {
        void closeTab(tab.id);
      });
      row.append(select, close);
      item = { row, select, close };
      rows.set(tab.id, item);
    }
    const title =
      tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url);
    if (item.select.textContent !== title) item.select.textContent = title;
    item.select.title =
      tab.url === 'about:blank' ? title : `${title} — ${tab.url}`;
    item.close.setAttribute('aria-label', `Close ${title}`);
    if (list.children[index] !== item.row)
      list.insertBefore(item.row, list.children[index] ?? null);
    suggestions.remember(tab.url, title);
  });
  updateChrome();
  if (previous !== state.active && !current) {
    setAddress();
    rows
      .get(desiredTab())
      ?.select.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  if (focusedTab && !rows.has(focusedTab))
    rows.get(desiredTab())?.select.focus();
}
function connect(takeover = false): void {
  view?.destroy();
  const endpoint = new URL('stream', location.href);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (takeover) endpoint.searchParams.set('takeover', '1');
  view = new DOMBrowserView(viewport, webSocketConnection(endpoint.href), {
    mediaControls: element('media-controls'),
    onTabs: renderTabs,
    onState: (state) => {
      if (state.status === 'error') element('toast').hidden = true;
      const changedTab = sourceID !== state.id;
      sourceID = state.id;
      sourceURL = state.url;
      canGoBack = state.canGoBack;
      canGoForward = state.canGoForward;
      if (
        desiredTab() === state.id &&
        ((changedTab && !addressEditing) || document.activeElement !== address)
      )
        address.value = state.url === 'about:blank' ? '' : state.url;
      document.title = state.title
        ? `${state.title} · FloeBrowser`
        : 'FloeBrowser';
      suggestions.remember(state.url, state.title);
      updateChrome();
    },
    onStatus: (status, reason) => {
      connected = status === 'live' || status === 'refreshing';
      ready = status === 'live';
      if (ready || status === 'disconnected') changingTab = false;
      if (status === 'disconnected') {
        for (const pending of commands.splice(0)) pending.resolve(false);
        hideSuggestions();
      }
      offerTakeover =
        status === 'disconnected' &&
        (reason === 'viewer_in_use' || reason === 'viewer_replaced');
      const label =
        status === 'refreshing'
          ? 'Loading'
          : connected
            ? 'Live'
            : status === 'connecting'
              ? 'Connecting'
              : 'Disconnected';
      element('status').className = `status ${status}`;
      element('status').textContent = label;
      element('status').title = label;
      overlay.hidden = connected;
      element('reconnect').hidden = status !== 'disconnected';
      element('reconnect').textContent = offerTakeover
        ? 'Use in this window'
        : 'Reconnect';
      element('connection-title').textContent =
        status === 'disconnected'
          ? reason === 'viewer_in_use'
            ? 'This browser is open in another window'
            : reason === 'viewer_replaced'
              ? 'Control moved to another window'
              : reason === 'source_unavailable'
                ? 'The source browser is unavailable'
                : 'Your connection was interrupted'
          : 'Connecting to your browser';
      element('connection-description').textContent =
        status === 'disconnected'
          ? offerTakeover
            ? 'Continue here with your open tabs and signed-in accounts.'
            : reason === 'source_unavailable'
              ? 'Check that the source browser is running, then reconnect.'
              : 'Reconnect to continue from your current page.'
          : 'Your page will appear shortly.';
      element('connection-symbol').className =
        `connection-symbol ${status === 'disconnected' ? 'disconnected-symbol' : ''}`;
      updateChrome();
    },
    onNotice: notice,
    onAddressFocus: focusAddress,
  });
}
function hideSuggestions(): void {
  suggestionList.hidden = true;
  selectedSuggestion = -1;
  address.setAttribute('aria-expanded', 'false');
  address.removeAttribute('aria-activedescendant');
}
function showSuggestions(): void {
  if (document.activeElement !== address || composing) return;
  matches = suggestions.match(address.value, tabState);
  selectedSuggestion = -1;
  address.removeAttribute('aria-activedescendant');
  suggestionList.replaceChildren(
    ...matches.map((match, index) => {
      const row = document.createElement('div');
      row.className = 'address-suggestion';
      row.id = `suggestion-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const text = document.createElement('span');
      text.className = 'suggestion-text';
      const title = document.createElement('span');
      title.className = 'suggestion-title';
      title.textContent = match.title;
      const url = document.createElement('span');
      url.className = 'suggestion-url';
      url.textContent = match.url;
      text.append(title, url);
      const kind = document.createElement('span');
      kind.className = 'suggestion-kind';
      kind.textContent =
        match.tab && match.tab !== tabState.active
          ? 'Switch to tab'
          : 'Visited';
      row.append(text, kind);
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => choose(match));
      return row;
    }),
  );
  suggestionList.hidden = !matches.length;
  address.setAttribute('aria-expanded', String(!!matches.length));
}
function focusAddress(): void {
  address.focus();
  address.select();
  showSuggestions();
}
function choose(match: AddressSuggestion): void {
  hideSuggestions();
  address.blur();
  if (match.tab && tabState.tabs.some((tab) => tab.id === match.tab))
    selectTab(match.tab);
  else navigate(match.url);
}
function navigate(value: string): void {
  const url = addressURL(value);
  if (!url) {
    notice('Enter a valid HTTP or HTTPS address, or a search term.');
    return;
  }
  hideSuggestions();
  address.blur();
  address.value = url;
  welcome.hidden = true;
  void command({ kind: 'navigate', url });
}
address.addEventListener('mousedown', (event) => {
  if (event.button === 0 && document.activeElement !== address) {
    event.preventDefault();
    focusAddress();
  }
});
address.addEventListener('focus', () => {
  address.select();
  showSuggestions();
});
address.addEventListener('blur', () => {
  addressEditing = false;
  hideSuggestions();
});
address.addEventListener('input', () => {
  addressEditing = true;
  showSuggestions();
});
address.addEventListener('compositionstart', () => {
  composing = true;
  hideSuggestions();
});
address.addEventListener('compositionend', () => {
  composing = false;
  showSuggestions();
});
address.addEventListener('keydown', (event) => {
  if (composing || event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    setAddress();
    address.select();
    hideSuggestions();
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (suggestionList.hidden) showSuggestions();
    if (!matches.length) return;
    if (selectedSuggestion === -1 && event.key === 'ArrowUp')
      selectedSuggestion = 0;
    selectedSuggestion =
      (selectedSuggestion +
        (event.key === 'ArrowDown' ? 1 : -1) +
        matches.length) %
      matches.length;
    for (let i = 0; i < suggestionList.children.length; i++)
      suggestionList.children[i]!.setAttribute(
        'aria-selected',
        String(i === selectedSuggestion),
      );
    address.setAttribute(
      'aria-activedescendant',
      `suggestion-${selectedSuggestion}`,
    );
    suggestionList.children[selectedSuggestion]?.scrollIntoView({
      block: 'nearest',
    });
  }
});
element('address-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (composing) return;
  if (selectedSuggestion >= 0 && !suggestionList.hidden)
    choose(matches[selectedSuggestion]!);
  else if (address.value.trim()) navigate(address.value);
});
element('new-tab').addEventListener('click', async () => {
  if (await command({ kind: 'tab_new' })) focusAddress();
});
for (const kind of ['back', 'forward', 'reload'] as const)
  element(kind).addEventListener('click', () => {
    void command({ kind });
  });
element('reconnect').addEventListener('click', () => connect(offerTakeover));
element('start-browsing').addEventListener('click', focusAddress);
element('dismiss-toast').addEventListener('click', () => {
  element('toast').hidden = true;
});
element('address-shortcut').textContent = /Mac/.test(navigator.platform)
  ? '⌘ L'
  : 'Ctrl L';
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.isComposing) return;
  if (event.key.toLowerCase() === 'l') {
    event.preventDefault();
    focusAddress();
  }
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    void command({ kind: 'reload' });
  }
});
window.addEventListener('pagehide', () => view?.destroy());
connect();
