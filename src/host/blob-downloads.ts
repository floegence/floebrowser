import { randomBytes } from 'node:crypto';
import type { SourceFrame, SourcePage, SourceTransport } from './source.js';

/** Runs in an admitted source document, never in the replay. Native object URL
 * behavior is preserved. Only immutable Blob references are temporarily held. */
function observeBlobURLs({ key, limit }: { key: string; limit: number }) {
  const target = globalThis as unknown as Record<string, any>;
  if (target[key]) return;
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  const sizeOf = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
  const slice = Blob.prototype.slice;
  const records = new Map<
    string,
    { blob: Blob; size: number; timer?: ReturnType<typeof setTimeout> }
  >();
  let bytes = 0,
    closed = false;
  const remove = (url: string) => {
    const record = records.get(url);
    if (!record) return;
    clearTimeout(record.timer);
    bytes -= record.size;
    records.delete(url);
  };
  const wrappedCreate: typeof create = function (this: typeof URL, blob) {
    const url = create.call(this, blob);
    if (closed) return url;
    let size: number;
    try {
      size = sizeOf.call(blob);
    } catch {
      return url;
    }
    if (size > limit) return url;
    while (records.size && (records.size >= 128 || bytes + size > limit))
      remove(records.keys().next().value!);
    records.set(url, { blob: blob as Blob, size });
    bytes += size;
    return url;
  };
  const wrappedRevoke: typeof revoke = function (this: typeof URL, url) {
    revoke.call(this, url);
    const record = records.get(url);
    // Native download notification follows the source call asynchronously.
    // Unclaimed revoked objects expire; they never become a durable history.
    if (record && !record.timer)
      record.timer = setTimeout(() => remove(url), 30000);
  };
  const api = {
    take(url: string) {
      const record = records.get(url);
      if (!record || closed) return undefined;
      const blob = slice.call(record.blob, 0, record.size);
      return blob;
    },
    close() {
      if (closed) return;
      closed = true;
      if (URL.createObjectURL === wrappedCreate) URL.createObjectURL = create;
      if (URL.revokeObjectURL === wrappedRevoke) URL.revokeObjectURL = revoke;
      for (const url of records.keys()) remove(url);
      if (target[key] === api) delete target[key];
    },
  };
  Object.defineProperty(target, key, { value: api, configurable: true });
  URL.createObjectURL = wrappedCreate;
  URL.revokeObjectURL = wrappedRevoke;
}

type Capture = {
  transport: SourceTransport;
  filename: string;
  acquire(): Promise<string>;
  finish(): Promise<void>;
};

/** Observes only this source's current default frame contexts and native
 * download events. It does not fetch object URLs or inspect personal files. */
export class BlobDownloads {
  private key = `__floeBlob_${randomBytes(16).toString('hex')}`;
  private frames = new Map<
    string,
    { frame: SourceFrame; context: number; ready: Promise<void> }
  >();
  private sessions = new Map<SourceTransport, () => void>();
  private pending = new Set<Promise<void>>();
  private closed = false;
  private disposers: Array<() => void> = [];
  constructor(
    private source: SourcePage,
    private capture: (value: Capture) => void,
    private unavailable: () => void,
  ) {}

  async start(): Promise<void> {
    const listen = (event: string, fn: (...args: any[]) => void) => {
      this.source.on(event, fn);
      this.disposers.push(() => this.source.off(event, fn));
    };
    listen('framecontext', (frame: SourceFrame) => {
      void this.frame(frame).catch(() => {});
    });
    listen('framedetached', (frame: SourceFrame) => {
      this.frames.delete(frame.id);
    });
    listen('sessionattached', (transport: SourceTransport) =>
      this.session(transport),
    );
    listen('sessiondetached', (transport: SourceTransport) => {
      this.sessions.get(transport)?.();
      this.sessions.delete(transport);
    });
    for (const transport of this.source.sessions()) this.session(transport);
    await Promise.all(this.source.frames().map((frame) => this.frame(frame)));
  }
  private frame(frame: SourceFrame): Promise<void> {
    if (this.closed || !frame.contextID) return Promise.resolve();
    const previous = this.frames.get(frame.id);
    if (previous?.context === frame.contextID) return previous.ready;
    // At most sixteen documents retain 32 MiB each: 512 MiB source-wide.
    if (!previous && this.frames.size >= 16) return Promise.resolve();
    const entry = { frame, context: frame.contextID, ready: Promise.resolve() };
    this.frames.set(frame.id, entry);
    entry.ready = frame.transport
      .send('Runtime.evaluate', {
        contextId: entry.context,
        expression: `(${observeBlobURLs.toString()})(${JSON.stringify({ key: this.key, limit: 32 * 1024 * 1024 })})`,
        returnByValue: true,
        timeout: 1000,
      })
      .then((result) => {
        if (result.exceptionDetails)
          throw new Error('Source Blob observation unavailable');
      })
      .catch((error) => {
        if (this.frames.get(frame.id) === entry) this.frames.delete(frame.id);
        throw error;
      });
    return entry.ready;
  }
  private session(transport: SourceTransport): void {
    if (this.closed || this.sessions.has(transport)) return;
    const download = (event: { url: string; suggestedFilename: string }) => {
      if (this.closed) return;
      if (!event.url.startsWith('blob:') || this.pending.size >= 4) {
        this.unavailable();
        return;
      }
      const work = this.download(event.url, event.suggestedFilename).catch(
        () => {
          if (!this.closed) this.unavailable();
        },
      );
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    };
    transport.on('Page.downloadWillBegin', download);
    this.sessions.set(transport, () =>
      transport.off('Page.downloadWillBegin', download),
    );
  }
  private async download(url: string, filename: string): Promise<void> {
    for (const entry of this.frames.values()) {
      if (this.closed) return;
      if (entry.frame.contextID !== entry.context) continue;
      await entry.ready;
      const transport = entry.frame.transport,
        group = `floe-download-${randomBytes(16).toString('hex')}`;
      const release = async () => {
        await transport
          .send('Runtime.releaseObjectGroup', { objectGroup: group })
          .catch(() => {});
      };
      const result = await transport.send('Runtime.evaluate', {
        contextId: entry.context,
        objectGroup: group,
        timeout: 1000,
        expression: `globalThis[${JSON.stringify(this.key)}]?.take(${JSON.stringify(url)})`,
      });
      if (!result.result?.objectId || result.exceptionDetails || this.closed) {
        await release();
        continue;
      }
      this.capture({
        transport,
        filename,
        finish: release,
        acquire: async () => {
          const { uuid } = await transport.send('IO.resolveBlob', {
            objectId: result.result.objectId,
          });
          if (typeof uuid !== 'string' || !/^[a-f0-9-]{36}$/iu.test(uuid))
            throw new Error('Source Blob unavailable');
          return `blob:${uuid}`;
        },
      });
      return;
    }
    throw new Error('Source Blob unavailable');
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    for (const dispose of this.sessions.values()) dispose();
    this.sessions.clear();
    await Promise.allSettled(this.pending);
    await Promise.allSettled(
      [...this.frames.values()].map(async (entry) => {
        await entry.ready;
        if (entry.frame.contextID !== entry.context) return;
        await entry.frame.transport.send('Runtime.evaluate', {
          contextId: entry.context,
          timeout: 1000,
          expression: `globalThis[${JSON.stringify(this.key)}]?.close()`,
        });
      }),
    );
    this.frames.clear();
  }
}
