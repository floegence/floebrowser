import './viewer.css';
import { DOMBrowserView, webSocketConnection } from './client.js';

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const address = element<HTMLInputElement>('address');
const overlay = element('connection-overlay');
const welcome = element('welcome');
let view: DOMBrowserView | undefined;
let sourceURL = 'about:blank';
let live = false;
let canGoBack = false;
let canGoForward = false;
let fit = true;
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
function connect(takeover = false): void {
  view?.destroy();
  const endpoint = new URL('stream', location.href);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (takeover) endpoint.searchParams.set('takeover', '1');
  view = new DOMBrowserView(
    element('viewport'),
    webSocketConnection(endpoint.href),
    {
      onState: (state) => {
        sourceURL = state.url;
        canGoBack = state.canGoBack;
        canGoForward = state.canGoForward;
        element<HTMLButtonElement>('back').disabled = !live || !canGoBack;
        element<HTMLButtonElement>('forward').disabled = !live || !canGoForward;
        if (document.activeElement !== address)
          address.value = state.url === 'about:blank' ? '' : state.url;
        element('page-title').textContent =
          state.title ||
          (state.url === 'about:blank' ? 'Source browser' : state.url);
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
        live = status === 'live';
        offerTakeover =
          status === 'disconnected' &&
          (reason === 'viewer_in_use' || reason === 'viewer_replaced');
        element('status').className = `status ${status}`;
        element('status').replaceChildren(
          Object.assign(document.createElement('span'), {}),
          document.createTextNode(
            live
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
        if (!live)
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
  view.setFit(fit);
}
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
element('fit').addEventListener('click', () => {
  fit = !fit;
  view?.setFit(fit);
  element('fit').firstChild!.textContent = fit ? 'Fit ' : '100% ';
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
