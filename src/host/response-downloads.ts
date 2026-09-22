import { randomBytes } from 'node:crypto';
import { BlobDownloads } from './blob-downloads.js';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SourcePage,
  SourceDownload,
  SourceDownloadState,
  SourceTransport,
} from './source.js';

type PausedResponse = {
  requestId: string;
  request?: { url: string };
  resourceType?: string;
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
};
type Transfer = {
  abort: AbortController;
  work: Promise<void>;
  state: SourceDownloadState;
  bytes: number;
  path?: string;
};
const fileLimit = 256 * 1024 * 1024;
const totalLimit = 512 * 1024 * 1024;

function filename(value: string, url?: string): string {
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(
    value,
  )?.[1];
  let name: string | undefined;
  if (extended) {
    try {
      name = decodeURIComponent(extended.trim());
    } catch {
      /* Invalid encoding uses the ordinary filename. */
    }
  }
  name ||= /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/iu
    .exec(value)
    ?.slice(1)
    .find(Boolean)
    ?.replace(/\\(.)/gu, '$1')
    .trim();
  if (!name && url) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
    } catch {
      // Invalid source URL encoding does not become a local filename.
    }
  }
  return (
    (name || 'download')
      .replace(/[\u0000-\u001f\u007f/\\]/gu, '_')
      .slice(0, 240) || 'download'
  );
}

/** An optional adapter for owners that lack native download file handles.
 * The SAME Fetch owner passes response-stage Document pauses here. An explicit
 * attachment or opaque binary response is consumed once from its original
 * source request. Other responses are left to the owner's normal policy.
 * No browser-wide setting, second request or personal download path is used. */
export class ResponseDownloads {
  private root?: Promise<string>;
  private closed = false;
  private entries = new Map<string, Transfer>();
  private bytes = 0;
  private closing?: Promise<void>;
  private blobs?: BlobDownloads;
  constructor(private report: (download: SourceDownload) => void) {}

  async observe(source: SourcePage, unavailable: () => void): Promise<void> {
    if (this.closed || this.blobs)
      throw new Error('Source downloads already observed');
    this.blobs = new BlobDownloads(
      source,
      (value) =>
        this.capture(
          value.transport,
          value.filename,
          value.acquire,
          value.finish,
        ),
      unavailable,
    );
    await this.blobs.start();
  }

  handle(transport: SourceTransport, event: PausedResponse): boolean {
    if (
      this.closed ||
      event.resourceType !== 'Document' ||
      !event.responseStatusCode ||
      event.responseStatusCode < 200 ||
      event.responseStatusCode >= 300
    )
      return false;
    const disposition =
      event.responseHeaders?.find(
        (header) => header.name.toLowerCase() === 'content-disposition',
      )?.value ?? '';
    const mime = event.responseHeaders
      ?.find((header) => header.name.toLowerCase() === 'content-type')
      ?.value.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      !/^attachment(?:\s*;|\s*$)/iu.test(disposition) &&
      mime !== 'application/octet-stream'
    )
      return false;
    this.capture(
      transport,
      filename(disposition, event.request?.url),
      async () => {
        const response = await transport.send(
          'Fetch.takeResponseBodyAsStream',
          { requestId: event.requestId },
        );
        return response.stream;
      },
      async () => {
        // Taking the body transfers this paused response to the host. Retire
        // the original navigation without reissuing it or inventing a body.
        await transport
          .send('Fetch.failRequest', {
            requestId: event.requestId,
            errorReason: 'Aborted',
          })
          .catch(() => {});
      },
    );
    return true;
  }

  private capture(
    transport: SourceTransport,
    name: string,
    acquire: () => Promise<string>,
    finish: () => Promise<void>,
  ): void {
    const id = randomBytes(24).toString('base64url');
    const entry: Transfer = {
      abort: new AbortController(),
      work: Promise.resolve(),
      bytes: 0,
      state: {
        id,
        filename:
          name.replace(/[\u0000-\u001f\u007f/\\]/gu, '_').slice(0, 240) ||
          'download',
        status: 'receiving',
        received: 0,
      },
    };
    const listeners = new Set<() => void>();
    const changed = () => {
      for (const listener of listeners) listener();
    };
    const active = [...this.entries.values()].filter(
      (item) => item.state.status === 'receiving',
    ).length;
    if (this.entries.size >= 128) {
      const oldest = [...this.entries].find(
        ([, item]) => item.state.status !== 'receiving',
      );
      if (oldest) {
        const [key, retired] = oldest;
        this.entries.delete(key);
        retired.abort.abort();
        this.bytes -= retired.bytes;
        if (retired.path)
          void rm(retired.path, { force: true }).catch(() => {});
      }
    }
    this.entries.set(id, entry);
    this.report({
      get state() {
        return { ...entry.state };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      open: async (signal) => {
        signal.throwIfAborted();
        if (
          this.closed ||
          this.entries.get(id) !== entry ||
          entry.state.status !== 'complete' ||
          !entry.path
        )
          throw new Error('Source download unavailable');
        return createReadStream(entry.path, {
          highWaterMark: 16384,
          signal: AbortSignal.any([signal, entry.abort.signal]),
        });
      },
      cancel: async () => {
        if (entry.state.status === 'receiving') {
          entry.abort.abort();
          await entry.work;
        }
      },
    });
    entry.work = (async () => {
      let stream: string | undefined;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      const signal = AbortSignal.any([
        entry.abort.signal,
        AbortSignal.timeout(5 * 60 * 1000),
      ]);
      const abort = () => {
        if (stream)
          void transport.send('IO.close', { handle: stream }).catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (active >= 4) throw new Error('Source download limit');
        signal.throwIfAborted();
        this.root ??= mkdtemp(join(tmpdir(), 'floebrowser-download-'));
        const directory = await this.root;
        signal.throwIfAborted();
        entry.path = join(directory, id);
        file = await open(entry.path, 'wx', 0o600);
        stream = await acquire();
        if (typeof stream !== 'string' || !stream)
          throw new Error('Source download unavailable');
        for (;;) {
          signal.throwIfAborted();
          const chunk = await transport.send('IO.read', {
            handle: stream,
            size: 32768,
          });
          signal.throwIfAborted();
          const bytes = Buffer.from(
            chunk.data,
            chunk.base64Encoded ? 'base64' : 'utf8',
          );
          if (
            entry.bytes + bytes.length > fileLimit ||
            this.bytes + bytes.length > totalLimit
          )
            throw new Error('Source download limit');
          entry.bytes += bytes.length;
          this.bytes += bytes.length;
          await file.writeFile(bytes);
          entry.state = { ...entry.state, received: entry.bytes };
          if (chunk.eof) break;
        }
        await file.close();
        file = undefined;
        entry.state = { ...entry.state, status: 'complete', size: entry.bytes };
      } catch {
        entry.state = {
          ...entry.state,
          status: entry.abort.signal.aborted ? 'canceled' : 'failed',
        };
        this.bytes -= entry.bytes;
        entry.bytes = 0;
        await file?.close().catch(() => {});
        file = undefined;
        if (entry.path) await rm(entry.path, { force: true }).catch(() => {});
      } finally {
        signal.removeEventListener('abort', abort);
        if (stream)
          await transport.send('IO.close', { handle: stream }).catch(() => {});
        await finish();
        changed();
      }
    })();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const entry of this.entries.values()) entry.abort.abort();
    return (this.closing = (async () => {
      await this.blobs?.close();
      await Promise.all([...this.entries.values()].map((entry) => entry.work));
      this.entries.clear();
      if (this.root)
        await rm(await this.root, { recursive: true, force: true });
    })());
  }
}
