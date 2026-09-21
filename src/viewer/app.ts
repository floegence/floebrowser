import './viewer.css';
import './style.css';
import { mountBrowser } from './browser.js';
import { webSocketConnection } from './client.js';

mountBrowser(document.body, {
  idPrefix: '',
  connect: ({ takeover }) => {
    const endpoint = new URL('stream', location.href);
    endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (takeover) endpoint.searchParams.set('takeover', '1');
    return webSocketConnection(endpoint.href);
  },
  onState: (state) => {
    document.title = state.title
      ? `${state.title} · FloeBrowser`
      : 'FloeBrowser';
  },
});
