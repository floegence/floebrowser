import type { BrowserText, BrowserMessageKey } from './messages.js';

const template = `    <main class="floe-browser browser-window">
      <div class="tab-strip">
        <div data-floe-ui="tabs" role="tablist"></div>
        <button
          data-floe-ui="new-tab"
          class="icon-button"
         
         
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
      </div>
      <span
        data-floe-ui="tab-announcement"
        class="sr-only"
        role="status"
        aria-live="polite"
      ></span>
      <nav data-floe-ui="navigation" class="toolbar">
        <div class="navigation-buttons">
          <button class="icon-button" data-floe-ui="back">
            <svg viewBox="0 0 20 20"><path d="m11 5-5 5 5 5M6 10h10" /></svg>
          </button>
          <button
            class="icon-button"
            data-floe-ui="forward"
           
           
          >
            <svg viewBox="0 0 20 20"><path d="m9 5 5 5-5 5M14 10H4" /></svg>
          </button>
          <button
            class="icon-button"
            data-floe-ui="reload"
           
           
          >
            <svg viewBox="0 0 20 20">
              <path d="M16 9a6 6 0 1 0-1 4M16 4v5h-5" />
            </svg>
          </button>
        </div>
        <form class="address-bar" data-floe-ui="address-form">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="7" />
            <path d="M3 10h14M10 3c4 4 4 10 0 14-4-4-4-10 0-14Z" />
          </svg>
          <input
            data-floe-ui="address"
           
            role="combobox"
            aria-autocomplete="list"
            aria-controls="address-suggestions"
            aria-expanded="false"
           
            maxlength="8192"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <button
            type="submit"
            data-floe-ui="address-go"
            class="icon-button"
           
           
          >
            <svg viewBox="0 0 20 20"><path d="M4 10h12m-5-5 5 5-5 5" /></svg>
          </button>
          <div
            data-floe-ui="address-suggestions"
            role="listbox"
           
            hidden
          ></div>
        </form>
        <button data-floe-ui="take-control" class="take-control" hidden></button>
        <div data-floe-ui="media-controls"></div>
        <span
          class="status connecting"
          data-floe-ui="status"
          role="status"
         
          ></span
        >
      </nav>
      <div class="stage">
        <div data-floe-ui="viewport"></div>
        <div class="welcome" data-floe-ui="welcome" hidden>
          <div class="new-tab-content">
            <svg
              class="new-tab-mark"
              viewBox="0 0 28 28"
              fill="none"
              aria-hidden="true"
            >
              <path d="M5 5h18v6H11v5h10v6H5V5Z" fill="currentColor" />
              <path d="m17 5 6 6V5h-6Z" fill="#a8b9d6" />
            </svg>
            <h1 data-floe-ui="browser-title"></h1>
            <button data-floe-ui="start-browsing">
              <svg viewBox="0 0 20 20">
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="m13 13 4 4" /></svg
              ><span data-floe-ui="start-label"></span
              ><kbd data-floe-ui="address-shortcut">Ctrl L</kbd>
            </button>
          </div>
        </div>
        <div class="connection-overlay" data-floe-ui="connection-overlay">
          <div class="connection-card">
            <span class="connection-symbol" data-floe-ui="connection-symbol"></span>
            <h2 data-floe-ui="connection-title"></h2>
            <p data-floe-ui="connection-description"></p>
            <button class="primary-button" data-floe-ui="reconnect" hidden>
            </button>
          </div>
        </div>
      </div>
    <div class="tab-menu" data-floe-ui="tab-menu" popover="manual" role="menu">
      <button data-floe-ui="tab-pin" role="menuitem"></button>
      <button data-floe-ui="tab-restore" role="menuitem"></button>
      <div class="menu-separator" role="separator"></div>
      <button data-floe-ui="tab-close" role="menuitem"></button>
    </div>
    <div class="toast" data-floe-ui="toast" role="status" hidden>
      <span data-floe-ui="toast-message"></span
      ><button data-floe-ui="dismiss-toast">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m6 6 8 8M14 6l-8 8" />
        </svg>
      </button>
    </div>

</main>`;

export function browserTemplate(
  title: string,
  text: BrowserText,
  prefix = `floe-${crypto.randomUUID()}-`,
): HTMLElement {
  const holder = document.createElement('template');
  holder.innerHTML = template;
  const root = holder.content.firstElementChild as HTMLElement;
  for (const node of root.querySelectorAll<HTMLElement>('[data-floe-ui]'))
    node.id = prefix + node.dataset.floeUi;
  const get = (id: string) =>
    root.querySelector<HTMLElement>(`[data-floe-ui="${id}"]`)!;
  get('browser-title').textContent = title;
  const labels: Record<string, BrowserMessageKey> = {
    tabs: 'tabs.list',
    'tab-menu': 'tabs.menu',
    navigation: 'navigation.label',
    address: 'address.label',
    'address-suggestions': 'address.suggestions',
    'address-go': 'address.open',
    'new-tab': 'tabs.new',
    back: 'navigation.back',
    forward: 'navigation.forward',
    reload: 'navigation.reloadPage',
    'dismiss-toast': 'notice.dismiss',
  };
  for (const [id, key] of Object.entries(labels)) {
    get(id).setAttribute('aria-label', text(key));
    if (get(id).tagName === 'BUTTON') get(id).title = text(key);
  }
  get('reload').title = text('navigation.reload');
  get('address-go').title = text('address.go');
  get('address').setAttribute('placeholder', text('address.placeholder'));
  get('address').setAttribute('aria-controls', get('address-suggestions').id);
  for (const [id, key] of Object.entries({
    'take-control': 'control.take',
    'tab-pin': 'tabs.pin',
    'tab-close': 'tabs.close',
    'tab-restore': 'tabs.restore',
    'start-label': 'address.placeholder',
    status: 'status.connecting',
    'connection-title': 'connection.connecting',
    'connection-description': 'connection.pending',
    reconnect: 'connection.reconnect',
  } satisfies Record<string, BrowserMessageKey>))
    get(id).textContent = text(key);
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    'button:not([type])',
  ))
    button.type = 'button';
  return root;
}
