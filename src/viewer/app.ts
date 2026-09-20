import './viewer.css';
import {
  DOMBrowserView,
  webSocketConnection,
  type ViewportMode,
} from './client.js';
import type { TabState } from '../shared/protocol.js';

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const address = element<HTMLInputElement>('address');
const overlay = element('connection-overlay');
const welcome = element('welcome');
let view: DOMBrowserView | undefined;
let sourceURL = 'about:blank';
let sourceID = '';
let tabState: TabState = { active: '', tabs: [] };
let live = false;
let canGoBack = false;
let canGoForward = false;
let viewportMode: ViewportMode = 'responsive';
let offerTakeover = false;
let toastTimer: ReturnType<typeof setTimeout>;

function notice(message: string): void {
  element('toast-message').textContent = message;
  element('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element('toast').hidden = true;
  }, 9000);
}
function renderTabs(state: TabState): void {
  tabState = state;
  const list = element('tabs');
  const focused = document.activeElement?.getAttribute('data-tab');
  list.replaceChildren(
    ...state.tabs.map((tab) => {
      const row = document.createElement('div');
      row.className = `tab ${tab.id === state.active ? 'active' : ''}`;
      const select = document.createElement('button');
      const title =
        tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url);
      select.className = 'tab-select';
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(tab.id === state.active));
      select.setAttribute('data-tab', tab.id);
      select.tabIndex = tab.id === state.active ? 0 : -1;
      select.title =
        tab.url === 'about:blank' ? title : `${title} — ${tab.url}`;
      select.textContent = title;
      select.addEventListener('click', () => {
        if (tab.id !== tabState.active)
          void view?.dispatch({ kind: 'tab_select', tab: tab.id });
      });
      select.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
          return;
        event.preventDefault();
        const index = tabState.tabs.findIndex((item) => item.id === tab.id);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabState.tabs.length - 1
              : (index +
                  (event.key === 'ArrowRight' ? 1 : -1) +
                  tabState.tabs.length) %
                tabState.tabs.length;
        void view?.dispatch({
          kind: 'tab_select',
          tab: tabState.tabs[next]!.id,
        });
      });
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.setAttribute('aria-label', `Close ${title}`);
      close.title = 'Close tab';
      close.textContent = '×';
      close.addEventListener('click', () => {
        void view?.dispatch({ kind: 'tab_close', tab: tab.id });
      });
      row.append(select, close);
      return row;
    }),
  );
  if (focused)
    list
      .querySelector<HTMLButtonElement>(`[data-tab="${state.active}"]`)
      ?.focus();
  list
    .querySelector('[aria-selected="true"]')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function connect(takeover = false): void {
  view?.destroy();
  const endpoint = new URL('stream', location.href);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (takeover) endpoint.searchParams.set('takeover', '1');
  view = new DOMBrowserView(
    element('viewport'),
    webSocketConnection(endpoint.href),
    {
      onTabs: renderTabs,
      onState: (state) => {
        const changedTab = sourceID !== state.id;
        sourceID = state.id;
        sourceURL = state.url;
        canGoBack = state.canGoBack;
        canGoForward = state.canGoForward;
        element<HTMLButtonElement>('back').disabled = !live || !canGoBack;
        element<HTMLButtonElement>('forward').disabled = !live || !canGoForward;
        if (changedTab || document.activeElement !== address)
          address.value = state.url === 'about:blank' ? '' : state.url;
        document.title = state.title
          ? `${state.title} · FloeBrowser`
          : 'FloeBrowser';
        element('viewport-size').textContent =
          `${state.width} × ${state.height}`;
        element('page-status').textContent =
          state.status === 'loading'
            ? 'Loading on the source machine…'
            : state.status === 'closed'
              ? 'Source browser closed'
              : 'Live from the source machine';
        welcome.hidden = !live || state.url !== 'about:blank';
      },
      onStatus: (status, reason) => {
        live = status === 'live' || status === 'refreshing';
        element<HTMLButtonElement>('new-tab').disabled =
          status === 'disconnected';
        for (const button of element('tabs').querySelectorAll('button'))
          button.disabled = status === 'disconnected';
        offerTakeover =
          status === 'disconnected' &&
          (reason === 'viewer_in_use' || reason === 'viewer_replaced');
        element('status').className = `status ${status}`;
        element('status').replaceChildren(
          Object.assign(document.createElement('span'), {}),
          document.createTextNode(
            status === 'refreshing'
              ? 'Updating view'
              : live
                ? 'Live'
                : status === 'connecting'
                  ? 'Connecting'
                  : 'Disconnected',
          ),
        );
        overlay.hidden = live;
        welcome.hidden = !live || sourceURL !== 'about:blank';
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
              ? 'Use this window to continue from the current page. The other window will disconnect; your source browser and login stay open.'
              : reason === 'source_unavailable'
                ? 'Check that the source browser is running, then reconnect.'
                : 'Reconnect to see the current page. Unconfirmed actions will not be repeated.'
            : 'Preparing a live view from the source machine.';
        element('connection-symbol').className =
          `connection-symbol ${status === 'disconnected' ? 'disconnected-symbol' : ''}`;
        element<HTMLButtonElement>('back').disabled = !live || !canGoBack;
        element<HTMLButtonElement>('forward').disabled = !live || !canGoForward;
        element<HTMLButtonElement>('reload').disabled = !live;
        address.disabled = !live;
        element<HTMLButtonElement>('address-go').disabled = !live;
        if (status === 'refreshing')
          element('page-status').textContent = 'Updating the source view…';
        else if (live)
          element('page-status').textContent = 'Live from the source machine';
        else
          element('page-status').textContent = offerTakeover
            ? 'Active in another window'
            : status === 'connecting'
              ? 'Connecting to the source browser'
              : 'Disconnected from the source browser';
      },
      onNotice: notice,
      onAddressFocus: () => {
        address.focus();
        address.select();
      },
      onAction: (milliseconds) => {
        element('action-time').textContent = `Action ${milliseconds} ms`;
      },
    },
  );
  view.setViewportMode(viewportMode);
}
element('new-tab').addEventListener('click', async () => {
  if (await view?.dispatch({ kind: 'tab_new' })) address.focus();
});
element('address-form').addEventListener('submit', (event) => {
  event.preventDefault();
  let url = address.value.trim();
  if (!url) return;
  if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = `https://${url}`;
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error();
  } catch {
    notice('Enter a valid HTTP or HTTPS website address.');
    return;
  }
  address.blur();
  welcome.hidden = true;
  void view?.dispatch({ kind: 'navigate', url });
});
for (const kind of ['back', 'forward', 'reload'] as const)
  element(kind).addEventListener('click', () => {
    void view?.dispatch({ kind });
  });
element('reconnect').addEventListener('click', () => connect(offerTakeover));
element('start-browsing').addEventListener('click', () => {
  address.focus();
  address.select();
});
element('viewport-mode').addEventListener('change', () => {
  viewportMode = element<HTMLSelectElement>('viewport-mode')
    .value as ViewportMode;
  view?.setViewportMode(viewportMode);
});
element('dismiss-toast').addEventListener('click', () => {
  element('toast').hidden = true;
});
const about = element<HTMLDialogElement>('about-dialog');
element('limitations').addEventListener('click', () => about.showModal());
for (const id of ['close-about', 'about-done'])
  element(id).addEventListener('click', () => about.close());
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 'l') {
    event.preventDefault();
    address.focus();
    address.select();
  }
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    void view?.dispatch({ kind: 'reload' });
  }
});
window.addEventListener('pagehide', () => view?.destroy());
connect();
