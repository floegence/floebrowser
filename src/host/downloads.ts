import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { Download } from 'playwright';
import type {
  SourceDownload,
  SourceDownloadState,
  SourcePage,
} from './source.js';
import type { DownloadFile } from '../shared/protocol.js';

/** Playwright's exact native download handle owns the file and credentials.
 * Its source-context lifetime owns disk cleanup; this adapter never scans paths. */
export function playwrightDownload(download: Download): SourceDownload {
  let state: SourceDownloadState = {
    id: randomBytes(24).toString('base64url'),
    filename: download.suggestedFilename(),
    status: 'receiving',
    received: 0,
  };
  let cancelRequested = false;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  void (async () => {
    try {
      if (await download.failure()) throw new Error('Native download failed');
      const path = await download.path();
      if (!path) throw new Error('Native download unavailable');
      const { size } = await stat(path);
      state = { ...state, status: 'complete', size, received: size };
    } catch {
      state = { ...state, status: cancelRequested ? 'canceled' : 'failed' };
    }
    changed();
  })();
  return {
    get state() {
      return { ...state };
    },
    subscribe(changed) {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
    async open(signal) {
      signal.throwIfAborted();
      if (state.status !== 'complete')
        throw new Error('Native download is not complete');
      const stream = await download.createReadStream();
      if (!stream) throw new Error('Native download is unavailable');
      const abort = () => stream.destroy();
      stream.once('close', () => signal.removeEventListener('abort', abort));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        stream.destroy();
        signal.throwIfAborted();
      }
      return stream;
    },
    async cancel() {
      if (state.status !== 'receiving') return;
      cancelRequested = true;
      await download.cancel();
    },
  };
}

async function readSourceDownload(
  source: SourcePage,
  id: string,
  allowed: () => boolean,
  signal: AbortSignal,
): Promise<DownloadFile> {
  const download = source.downloads().find((file) => file.state.id === id);
  const authorized = () =>
    allowed() && !source.isClosed() && source.downloads().includes(download!);
  if (!download || !authorized() || download.state.status !== 'complete')
    throw new Error('Download unavailable');
  const active = signal;
  const stream = await download.open(active);
  if (active.aborted || !authorized()) {
    void Promise.resolve(stream[Symbol.asyncIterator]().return?.()).catch(
      () => {},
    );
    throw new Error('Download authorization expired');
  }
  return {
    filename: download.state.filename,
    size: download.state.size,
    body: (async function* () {
      let received = 0;
      for await (const chunk of stream) {
        active.throwIfAborted();
        if (!authorized()) throw new Error('Download authorization expired');
        if (!(chunk instanceof Uint8Array))
          throw new Error('Invalid source download bytes');
        received += chunk.length;
        if (download.state.size !== undefined && received > download.state.size)
          throw new Error('Source download size changed');
        for (let offset = 0; offset < chunk.length; offset += 16 * 1024) {
          active.throwIfAborted();
          if (!authorized()) throw new Error('Download authorization expired');
          yield chunk.subarray(offset, offset + 16 * 1024);
        }
      }
      active.throwIfAborted();
      if (!authorized()) throw new Error('Download authorization expired');
      if (download.state.size !== undefined && received !== download.state.size)
        throw new Error('Source download is incomplete');
    })(),
  };
}

/** Each viewing connection owns a bounded set of reads. Revoking observation
 * aborts producers immediately, including reads still waiting for their first byte. */
export class DownloadTransfers {
  private active = new Map<AbortController, SourcePage>();
  private closed = false;
  async open(
    source: SourcePage,
    id: string,
    allowed: () => boolean,
    signal?: AbortSignal,
  ): Promise<DownloadFile> {
    if (this.closed || this.active.size >= 4 || !allowed())
      throw new Error('Download unavailable');
    signal?.throwIfAborted();
    const abort = new AbortController();
    this.active.set(abort, source);
    const active = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
    const release = () => {
      this.active.delete(abort);
      active.removeEventListener('abort', release);
    };
    active.addEventListener('abort', release, { once: true });
    try {
      const file = await readSourceDownload(source, id, allowed, active);
      return {
        ...file,
        body: (async function* () {
          try {
            yield* file.body;
          } finally {
            release();
          }
        })(),
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  retain(allowed: (page: SourcePage) => boolean): void {
    for (const [abort, page] of this.active) if (!allowed(page)) abort.abort();
  }
  close(): void {
    this.closed = true;
    for (const abort of this.active.keys()) abort.abort();
  }
}
