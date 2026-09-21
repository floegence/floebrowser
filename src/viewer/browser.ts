import { TabOrder } from './tabs.js';
import { setIcon } from './icons.js';
import { DOMBrowserView, type ViewOptions } from './client.js';
import { browserText } from './messages.js';
import { WebsiteDialog } from './dialog.js';
import { PageFind } from './find.js';
import { PageZoom } from './zoom.js';
import { FilePicker } from './files.js';
import { Downloads } from './downloads.js';
import { browserTemplate } from './template.js';
import {
  AddressSuggestions,
  addressURL,
  type AddressSuggestion,
} from './address.js';
import type {
  Action,
  TabState,
  ProjectionConnection,
} from '../shared/protocol.js';

/** Each mount owns only its DOM and carrier. The host owns source grants,
 * persisted browsing data, titles and the underlying environment connection. */
export type BrowserOptions = Omit<
  ViewOptions,
  'mediaControls' | 'onAddressFocus' | 'onShortcut'
> & {
  connect: (request: { takeover: boolean }) => ProjectionConnection;
  title?: string;
  /** Host-owned authorized history/bookmarks/tabs; never contact a search engine
   * on each keystroke. Omission uses this view's bounded in-memory visits. */
  suggest?: (
    query: string,
    context: { tabs: TabState; signal: AbortSignal },
  ) => readonly AddressSuggestion[] | Promise<readonly AddressSuggestion[]>;
  /** Invoked only when a user submits a search, never while typing. */
  searchURL?: (query: string) => string;
  /** The product performs user/AI takeover through its authorized host API. */
  onTakeControl?: (target: string) => void | Promise<void>;
  /** A unique ID namespace. The standalone document uses the empty prefix. */
  idPrefix?: string;
};
export type BrowserView = {
  destroy(): void;
  focusAddress(): void;
  navigate(value: string): void;
  dispatch(action: Action): Promise<boolean>;
  reconnect(takeover?: boolean): void;
};
export function mountBrowser(
  container: HTMLElement,
  options: BrowserOptions,
): BrowserView {
  const text = browserText(options.messages);
  const root = browserTemplate(
    options.title ?? 'FloeBrowser',
    text,
    options.idPrefix,
  );
  container.append(root);
  const element = <T extends HTMLElement = HTMLElement>(id: string) =>
    root.querySelector<T>(`[data-floe-ui="${id}"]`)!;
  let destroyed = false;
  let generation = 0;
  const lifetime = new AbortController();
  const address = element<HTMLInputElement>('address');
  const overlay = element('connection-overlay');
  const welcome = element('welcome');
  const viewport = element('viewport');
  const stage = viewport.parentElement!;
  const suggestions = new AddressSuggestions();
  const suggestionList = element('address-suggestions');
  let matches: AddressSuggestion[] = [];
  let selectedSuggestion = -1;
  let suggestionRequest: AbortController | undefined;
  let composing = false;
  let addressEditing = false;
  let view: DOMBrowserView | undefined;
  let sourceURL = 'about:blank';
  let sourceID = '';
  let tabState: TabState = { active: '', tabs: [] };
  let connected = false;
  let controlling = false;
  let takingControl = false;
  let editTabs = true;
  let ready = false;
  let changingTab = false;
  let loading = false;
  let dialogOpen = false;
  let filePickerOpen = false;
  let canGoBack = false;
  let canGoForward = false;
  let offerTakeover = false;
  let toastTimer: ReturnType<typeof setTimeout>;
  const zoom = new PageZoom(
    element<HTMLButtonElement>('zoom'),
    stage,
    text,
    (action) => command(action),
  );
  const find = new PageFind(
    stage,
    text,
    (action) => view?.dispatch(action) ?? Promise.resolve(false),
  );
  const dialog = new WebsiteDialog(
    stage,
    text,
    (action) => view?.dispatch(action) ?? Promise.resolve(false),
    (visible) => {
      dialogOpen = visible;
      updateChrome();
    },
  );
  const files = new FilePicker(
    stage,
    text,
    (request, file, signal) => view!.upload(request, file, signal),
    (action) => view?.dispatch(action) ?? Promise.resolve(false),
    (visible) => {
      filePickerOpen = visible;
      updateChrome();
    },
  );
  const downloads = new Downloads(
    element<HTMLButtonElement>('downloads'),
    stage,
    text,
    (target, id, signal) => view!.download(target, id, signal),
    (action) => command(action),
  );
  // Only unsent tab selections are replaceable. Submitted effects are never replayed.
  type ChromeCommand = { action: Action; resolve: (ok: boolean) => void };
  const commands: ChromeCommand[] = [];
  let current: ChromeCommand | undefined;
  const rows = new Map<
    string,
    { row: HTMLElement; select: HTMLButtonElement; close: HTMLButtonElement }
  >();
  const tabOrder = new TabOrder(
    element('tabs'),
    () => connected && editTabs && !switching(),
    (tab, before) => command({ kind: 'tab_move', tab, before }),
    (message) => {
      element('tab-announcement').textContent = message;
    },
    text,
  );

  function notice(message: string): void {
    if (destroyed) return;
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
            command.action.kind === 'tab_restore' ||
            (command.action.kind === 'tab_close' &&
              command.action.tab === tabState.active)),
      )
    );
  }
  function updateChrome(): void {
    downloads.enable(connected, controlling, view?.canDownload ?? false);
    if (!connected) tabOrder.cancel();
    const selected = desiredTab();
    const pending = switching();
    stage.classList.toggle('switching', connected && pending);
    stage.classList.toggle('loading', connected && loading);
    element('reload').title = text(
      loading ? 'navigation.stop' : 'navigation.reload',
    );
    element('reload').setAttribute(
      'aria-label',
      text(loading ? 'navigation.stop' : 'navigation.reloadPage'),
    );
    setIcon(element('reload'), loading ? 'close' : 'reload');
    viewport.inert =
      !connected || !ready || pending || dialogOpen || filePickerOpen;
    const canFind =
      connected &&
      controlling &&
      ready &&
      !pending &&
      !dialogOpen &&
      !filePickerOpen;
    element<HTMLButtonElement>('find').disabled = !canFind;
    find.enable(canFind);
    zoom.enable(
      connected && controlling && !pending && !dialogOpen && !filePickerOpen,
    );
    for (const [id, item] of rows) {
      item.row.classList.toggle('active', id === selected);
      item.select.setAttribute('aria-selected', String(id === selected));
      item.select.tabIndex = id === selected ? 0 : -1;
      item.select.disabled = !connected;
      item.close.disabled = !connected || !editTabs;
    }
    element<HTMLButtonElement>('new-tab').disabled = !connected || !editTabs;
    element<HTMLButtonElement>('back').disabled =
      !connected || !controlling || pending || !canGoBack;
    element<HTMLButtonElement>('forward').disabled =
      !connected || !controlling || pending || !canGoForward;
    element<HTMLButtonElement>('reload').disabled =
      !connected || !controlling || pending;
    address.disabled = !connected;
    address.readOnly = !controlling && !pending;
    element<HTMLButtonElement>('address-go').disabled =
      !connected || (!controlling && !pending);
    element('take-control').hidden =
      !connected || !tabState.active || controlling || !options.onTakeControl;
    element<HTMLButtonElement>('take-control').disabled = takingControl;
    element('take-control').textContent = text(
      takingControl ? 'control.pending' : 'control.take',
    );
    const target = tabState.tabs.find((tab) => tab.id === selected);
    welcome.hidden = !connected || pending || target?.url !== 'about:blank';
  }
  function command(action: Action): Promise<boolean> {
    if (!connected || destroyed) return Promise.resolve(false);
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
      const admittedGeneration = generation;
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
      if (destroyed || generation !== admittedGeneration) return;
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
  function newTab(): void {
    if (!connected || !editTabs) return;
    void command({ kind: 'tab_new' });
    address.value = '';
    addressEditing = false;
    // Focus belongs to the user's new-tab intent. A later admission reply
    // must not steal it back after they have submitted an address or clicked.
    focusAddress();
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
    rows
      .get(id)
      ?.select.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  async function closeTab(id: string): Promise<void> {
    if (!editTabs || closingTab(id)) return;
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
    options.onTabs?.(state);
    const previous = tabState.active;
    if (previous !== state.active) find.close();
    if (previous !== state.active)
      loading = !!state.tabs.find((tab) => tab.id === state.active)?.loading;
    const scopeChanged =
      JSON.stringify(state.tabs.map((tab) => [tab.id, tab.url])) !==
      JSON.stringify(tabState.tabs.map((tab) => [tab.id, tab.url]));
    if (menuTab && !state.tabs.some((tab) => tab.id === menuTab))
      element('tab-menu').hidePopover();
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
    state.tabs.forEach((tab) => {
      let item = rows.get(tab.id);
      if (!item) {
        const row = document.createElement('div');
        row.className = 'tab';
        row.dataset.tabId = tab.id;
        const select = document.createElement('button');
        select.className = 'tab-select';
        select.setAttribute('role', 'tab');
        select.dataset.tab = tab.id;
        select.setAttribute(
          'aria-keyshortcuts',
          'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+Home Alt+Shift+End',
        );
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
        close.title = text('tabs.close');
        setIcon(close, 'close');
        close.addEventListener('click', () => {
          void closeTab(tab.id);
        });
        row.append(select, close);
        item = { row, select, close };
        rows.set(tab.id, item);
        list.append(row);
      }
      const title =
        tab.title || (tab.url === 'about:blank' ? text('tabs.new') : tab.url);
      item.row.classList.toggle('pinned', !!tab.pinned);
      const label = tab.pinned ? Array.from(title)[0]! : title;
      if (item.select.textContent !== label) item.select.textContent = label;
      item.select.setAttribute('aria-label', title);
      item.select.title =
        tab.url === 'about:blank' ? title : `${title} — ${tab.url}`;
      item.close.setAttribute('aria-label', text('tabs.closeNamed', { title }));
      if (!options.suggest) suggestions.remember(tab.url, title);
    });
    tabOrder.sync(state.tabs.map((tab) => tab.id));
    if (scopeChanged) {
      hideSuggestions();
      showSuggestions();
    }
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
    if (destroyed) return;
    const admittedGeneration = ++generation;
    for (const pending of commands.splice(0)) pending.resolve(false);
    current?.resolve(false);
    current = undefined;
    view?.destroy();
    dialog.show(null);
    find.close();
    connected = ready = changingTab = false;
    view = new DOMBrowserView(viewport, options.connect({ takeover }), {
      messages: options.messages,
      mediaAssets: options.mediaAssets,
      onAction: options.onAction,
      onFind: (result) => {
        find.result(result);
        options.onFind?.(result);
      },
      onDialog: (state) => {
        dialog.show(state);
        options.onDialog?.(state);
      },
      onFileChooser: (request) => {
        files.show(request, view?.canUpload);
        options.onFileChooser?.(request);
      },
      onDownloads: (target, items) => {
        downloads.state(target, items);
        options.onDownloads?.(target, items);
      },
      onControl: (active) => {
        controlling = active;
        options.onControl?.(active);
        updateChrome();
      },
      onSessionAccess: (allowed) => {
        editTabs = allowed;
        options.onSessionAccess?.(allowed);
        updateChrome();
      },
      mediaControls: element('media-controls'),
      onTabs: (state) => {
        downloads.tabs(state);
        if (generation === admittedGeneration && !destroyed) renderTabs(state);
      },
      onState: (state) => {
        if (generation !== admittedGeneration || destroyed) return;
        options.onState?.(state);
        zoom.state(state);
        if (state.status === 'error') element('toast').hidden = true;
        const changedTab = sourceID !== state.id;
        sourceID = state.id;
        sourceURL = state.url;
        loading = state.loading;
        canGoBack = state.canGoBack;
        canGoForward = state.canGoForward;
        if (
          desiredTab() === state.id &&
          ((changedTab && !addressEditing) ||
            document.activeElement !== address)
        )
          address.value = state.url === 'about:blank' ? '' : state.url;
        if (!options.suggest) suggestions.remember(state.url, state.title);
        updateChrome();
      },
      onStatus: (status, reason) => {
        if (generation !== admittedGeneration || destroyed) return;
        options.onStatus?.(status, reason);
        connected = status === 'live' || status === 'refreshing';
        ready = status === 'live';
        if (ready || status === 'disconnected') changingTab = false;
        if (status === 'disconnected') {
          find.close();
          dialog.show(null);
          for (const pending of commands.splice(0)) pending.resolve(false);
          hideSuggestions();
        }
        offerTakeover =
          status === 'disconnected' &&
          (reason === 'viewer_in_use' || reason === 'viewer_replaced');
        const label =
          status === 'refreshing'
            ? text('status.loading')
            : connected
              ? text('status.live')
              : status === 'connecting'
                ? text('status.connecting')
                : text('status.disconnected');
        element('status').className = `status ${status}`;
        element('status').textContent = label;
        element('status').title = label;
        overlay.hidden = connected;
        element('reconnect').hidden = status !== 'disconnected';
        element('reconnect').textContent = offerTakeover
          ? text('connection.useHere')
          : text('connection.reconnect');
        element('connection-title').textContent =
          status === 'disconnected'
            ? reason === 'viewer_in_use'
              ? text('connection.otherWindow')
              : reason === 'viewer_replaced'
                ? text('connection.transferred')
                : reason === 'source_unavailable'
                  ? text('connection.unavailable')
                  : text('connection.interrupted')
            : text('connection.connecting');
        element('connection-description').textContent =
          status === 'disconnected'
            ? offerTakeover
              ? text('connection.continue')
              : reason === 'source_unavailable'
                ? text('connection.checkSource')
                : text('connection.resume')
            : text('connection.pending');
        element('connection-symbol').className =
          `connection-symbol ${status === 'disconnected' ? 'disconnected-symbol' : ''}`;
        updateChrome();
      },
      onNotice: (message) => {
        if (generation === admittedGeneration && !destroyed) {
          notice(message);
          options.onNotice?.(message);
        }
      },
      onAddressFocus: focusAddress,
      onShortcut: shortcut,
    });
  }
  function hideSuggestions(): void {
    suggestionRequest?.abort();
    suggestionRequest = undefined;
    matches = [];
    suggestionList.hidden = true;
    selectedSuggestion = -1;
    address.setAttribute('aria-expanded', 'false');
    address.removeAttribute('aria-activedescendant');
  }
  function showSuggestions(): void {
    if (destroyed || document.activeElement !== address || composing) return;
    hideSuggestions();
    const request = new AbortController();
    suggestionRequest = request;
    const query = address.value;
    const render = (items: readonly AddressSuggestion[]) => {
      if (
        destroyed ||
        request.signal.aborted ||
        document.activeElement !== address ||
        address.value !== query ||
        composing
      )
        return;
      matches = items
        .filter(
          (item) =>
            /^https?:\/\//i.test(item.url) &&
            !!addressURL(item.url) &&
            (!item.tab || tabState.tabs.some((tab) => tab.id === item.tab)),
        )
        .slice(0, 6)
        .map((item) => ({ ...item }));
      renderSuggestions();
    };
    if (!options.suggest) {
      render(suggestions.match(query, tabState));
      return;
    }
    try {
      const result = options.suggest(query, {
        tabs: {
          active: tabState.active,
          tabs: tabState.tabs.map((tab) => ({ ...tab })),
        },
        signal: request.signal,
      });
      void Promise.resolve(result).then(render, () => {
        if (!request.signal.aborted) hideSuggestions();
      });
    } catch {
      hideSuggestions();
    }
  }
  function renderSuggestions(): void {
    suggestionList.replaceChildren(
      ...matches.map((match, index) => {
        const row = document.createElement('div');
        row.className = 'address-suggestion';
        row.id = `${suggestionList.id}-${index}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        const description = document.createElement('span');
        description.className = 'suggestion-text';
        const title = document.createElement('span');
        title.className = 'suggestion-title';
        title.textContent = match.title;
        const url = document.createElement('span');
        url.className = 'suggestion-url';
        url.textContent = match.url;
        description.append(title, url);
        const kind = document.createElement('span');
        kind.className = 'suggestion-kind';
        kind.textContent =
          match.tab && match.tab !== tabState.active
            ? text('address.switchTab')
            : text(match.bookmarked ? 'address.bookmark' : 'address.visited');
        row.append(description, kind);
        row.addEventListener('mousedown', (event) => event.preventDefault());
        row.addEventListener('click', () => choose(match));
        return row;
      }),
    );
    suggestionList.hidden = !matches.length;
    address.setAttribute('aria-expanded', String(!!matches.length));
  }
  function focusAddress(): void {
    const focused = document.activeElement === address;
    address.focus();
    address.select();
    if (focused) showSuggestions();
  }
  function choose(match: AddressSuggestion): void {
    hideSuggestions();
    address.blur();
    if (match.tab) {
      if (tabState.tabs.some((tab) => tab.id === match.tab))
        selectTab(match.tab);
    } else navigate(match.url);
  }
  function navigate(value: string): void {
    const url = addressURL(value, options.searchURL);
    if (!url) {
      notice(text('address.invalid'));
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
      event.stopPropagation();
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
        `${suggestionList.id}-${selectedSuggestion}`,
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
  element('new-tab').addEventListener('click', newTab);
  element('find').addEventListener('click', () => find.open());
  for (const kind of ['back', 'forward', 'reload'] as const)
    element(kind).addEventListener('click', () => {
      void command({ kind: kind === 'reload' && loading ? 'stop' : kind });
    });
  element('take-control').addEventListener('click', async () => {
    if (takingControl || !tabState.active) return;
    const target = tabState.active;
    takingControl = true;
    updateChrome();
    try {
      await options.onTakeControl?.(target);
    } catch {
      if (!destroyed && tabState.active === target)
        notice(text('control.failed'));
    } finally {
      takingControl = false;
      if (!destroyed) updateChrome();
    }
  });
  element('reconnect').addEventListener('click', () => connect(offerTakeover));
  element('start-browsing').addEventListener('click', focusAddress);
  element('dismiss-toast').addEventListener('click', () => {
    element('toast').hidden = true;
  });
  element('address-shortcut').textContent = /Mac/.test(navigator.platform)
    ? '⌘ L'
    : 'Ctrl L';
  function shortcut(event: KeyboardEvent, phase: 'down' | 'up'): boolean {
    if (event.key === 'Escape' && !event.isComposing && loading) {
      if (phase === 'down') void command({ kind: 'stop' });
      event.preventDefault();
      return true;
    }
    if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey)
      return false;
    const key = event.key.toLowerCase();
    if (!['l', 'r', 't', 'w', 'tab', 'f', '+', '=', '-', '0'].includes(key))
      return false;
    if (phase === 'up') return true;
    event.preventDefault();
    if (['+', '=', '-', '0'].includes(key)) {
      if (key === '0') zoom.change(1);
      else zoom.step(key === '-' ? -1 : 1);
      return true;
    }
    if (event.repeat) return true;
    if (key === 'l') focusAddress();
    else if (key === 'f') find.open();
    else if (key === 'r') void command({ kind: 'reload' });
    else if (key === 't') {
      if (event.shiftKey) void command({ kind: 'tab_restore' });
      else newTab();
    } else if (key === 'w' && desiredTab()) void closeTab(desiredTab());
    else if (key === 'tab' && tabState.tabs.length) {
      const index = tabState.tabs.findIndex((tab) => tab.id === desiredTab());
      const next =
        (index + (event.shiftKey ? -1 : 1) + tabState.tabs.length) %
        tabState.tabs.length;
      selectTab(tabState.tabs[next]!.id);
    }
    return true;
  }
  root.addEventListener('keydown', (event) => {
    if (shortcut(event, 'down')) event.stopPropagation();
  });
  root.addEventListener('keyup', (event) => {
    if (shortcut(event, 'up')) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  const tabMenu = element('tab-menu');
  let menuTab = '';
  // Contextmenu can fire before the opening pointerup. An auto popover would
  // immediately light-dismiss on that same release; own dismissal explicitly.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!tabMenu.contains(event.target as Node)) tabMenu.hidePopover();
    },
    { capture: true, signal: lifetime.signal },
  );
  window.addEventListener('blur', () => tabMenu.hidePopover(), {
    signal: lifetime.signal,
  });
  tabMenu.addEventListener('focusout', (event) => {
    if (!tabMenu.contains(event.relatedTarget as Node | null))
      tabMenu.hidePopover();
  });
  element('tabs').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!connected) return;
    menuTab =
      (event.target as Element).closest<HTMLElement>('[data-tab-id]')?.dataset
        .tabId ?? '';
    const target = tabState.tabs.find((tab) => tab.id === menuTab);
    element<HTMLButtonElement>('tab-pin').disabled = !target || !editTabs;
    element<HTMLButtonElement>('tab-close').disabled = !target || !editTabs;
    element<HTMLButtonElement>('tab-restore').disabled = !editTabs;
    element('tab-pin').textContent = text(
      target?.pinned ? 'tabs.unpin' : 'tabs.pin',
    );
    tabMenu.showPopover();
    tabMenu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - tabMenu.offsetWidth - 8))}px`;
    tabMenu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - tabMenu.offsetHeight - 8))}px`;
    tabMenu.querySelector<HTMLButtonElement>('button:enabled')?.focus();
  });
  element('tab-pin').addEventListener('click', () => {
    tabMenu.hidePopover();
    const target = tabState.tabs.find((tab) => tab.id === menuTab);
    if (target)
      void command({ kind: 'tab_pin', tab: target.id, pinned: !target.pinned });
  });
  element('tab-close').addEventListener('click', () => {
    tabMenu.hidePopover();
    if (menuTab) void closeTab(menuTab);
  });
  element('tab-restore').addEventListener('click', () => {
    tabMenu.hidePopover();
    void command({ kind: 'tab_restore' });
  });
  tabMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      tabMenu.hidePopover();
      rows.get(menuTab)?.select.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [
      ...tabMenu.querySelectorAll<HTMLButtonElement>('button:enabled'),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
  });
  window.addEventListener('pagehide', destroy, { signal: lifetime.signal });
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    generation++;
    lifetime.abort();
    suggestionRequest?.abort();
    clearTimeout(toastTimer);
    for (const pending of commands.splice(0)) pending.resolve(false);
    current?.resolve(false);
    current = undefined;
    tabOrder.destroy();
    dialog.destroy();
    find.destroy();
    zoom.destroy();
    files.destroy();
    downloads.destroy();
    view?.destroy();
    root.remove();
  }
  try {
    connect();
  } catch (error) {
    destroy();
    throw error;
  }
  return {
    destroy,
    focusAddress,
    navigate,
    dispatch: command,
    reconnect: connect,
  };
}
