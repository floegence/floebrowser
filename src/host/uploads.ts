import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { UploadFile } from '../shared/protocol.js';
import type { SourcePage, SourceFrame } from './source.js';

export type UploadLimits = { bytes?: number; files?: number };
const sourceStores = new WeakMap<
  SourcePage,
  ReturnType<typeof createSourceStore>
>();
export function sourceUploads(page: SourcePage, limits?: UploadLimits) {
  let store = sourceStores.get(page);
  if (!store) {
    store = createSourceStore(page, limits);
    sourceStores.set(page, store);
  }
  return store;
}
function createSourceStore(page: SourcePage, limits?: UploadLimits) {
  const budget = new UploadBudget(limits);
  const retained = new Set<{
    batch: UploadBatch;
    frame: SourceFrame;
    context: number;
  }>();
  const changed = () => {
    for (const entry of retained) {
      if (
        !page.isClosed() &&
        !entry.frame.isDetached() &&
        entry.frame.contextID === entry.context
      )
        continue;
      retained.delete(entry);
      void entry.batch.close().catch(() => {});
    }
  };
  const close = () => {
    changed();
    page.off('documentchanged', changed);
    page.off('framedetached', changed);
    page.off('close', close);
    sourceStores.delete(page);
  };
  page.on('documentchanged', changed);
  page.on('framedetached', changed);
  page.on('close', close);
  return {
    budget,
    retain(batch: UploadBatch, frame: SourceFrame) {
      retained.add({ batch, frame, context: frame.contextID });
    },
  };
}

/** One source page's disk budget, including files still referenced by its DOM.
 * No client path is ever interpreted as a source-host filesystem location. */
export class UploadBudget {
  private bytes = 0;
  private files = 0;
  readonly limits: Required<UploadLimits>;
  constructor(limits: UploadLimits = {}) {
    this.limits = { bytes: 256 * 1024 * 1024, files: 128, ...limits };
    if (
      Object.values(this.limits).some((v) => !Number.isSafeInteger(v) || v < 1)
    )
      throw new Error('Invalid upload budget');
  }
  create(directory: boolean): UploadBatch {
    return new UploadBatch(this, directory);
  }
  get remaining() {
    return {
      maxBytes: this.limits.bytes - this.bytes,
      maxFiles: Math.min(128, this.limits.files - this.files),
    };
  }
  reserve(bytes: number): () => void {
    if (
      this.bytes + bytes > this.limits.bytes ||
      this.files >= this.limits.files
    )
      throw new Error('Source upload budget exceeded');
    this.bytes += bytes;
    this.files++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bytes -= bytes;
      this.files--;
    };
  }
}

export class UploadBatch {
  private root?: Promise<string>;
  private abort = new AbortController();
  private entries = new Map<
    string,
    { relative: string; complete: boolean; release: () => void }
  >();
  private pending = new Set<Promise<string>>();
  private directoryName = '';
  private committed = false;
  private closing?: Promise<void>;
  constructor(
    private budget: UploadBudget,
    private directory: boolean,
  ) {}

  write(
    file: UploadFile,
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      if (this.committed || this.abort.signal.aborted)
        throw new Error('File chooser expired');
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !validName(file.name)
      )
        throw new Error('Invalid upload metadata');
      const id = randomBytes(24).toString('base64url');
      const parts = file.relativePath?.split('/') ?? [];
      if ((file.relativePath?.length ?? 0) > 4096 || parts.length > 32)
        throw new Error('Upload path limit exceeded');
      if (
        this.directory &&
        (parts.length < 2 ||
          parts.at(-1) !== file.name ||
          parts.some((part) => !validName(part)))
      )
        throw new Error('Invalid upload directory');
      if (!this.directory && file.relativePath)
        throw new Error('Unexpected upload directory');
      if (this.directoryName && parts[0] !== this.directoryName)
        throw new Error('Multiple upload roots');
      const relative = this.directory ? parts.join('/') : `${id}/${file.name}`;
      // Match names conservatively across case-sensitive and case-insensitive hosts.
      if (
        [...this.entries.values()].some(
          (entry) => entry.relative.toLowerCase() === relative.toLowerCase(),
        )
      )
        throw new Error('Duplicate upload path');
      const release = this.budget.reserve(file.size);
      if (this.directory) this.directoryName = parts[0]!;
      const entry = { relative, complete: false, release };
      this.entries.set(id, entry);
      const active = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(120000),
        ...(signal ? [signal] : []),
      ]);
      const work = this.stage(file, body, active, relative)
        .then(() => {
          active.throwIfAborted();
          entry.complete = true;
          return id;
        })
        .catch(async (error) => {
          if (this.root)
            await rm(join(await this.root, relative), { force: true }).catch(
              () => {},
            );
          this.entries.delete(id);
          release();
          throw error;
        });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work)).catch(() => {});
      return work;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private async stage(
    file: UploadFile,
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    relative: string,
  ): Promise<void> {
    signal.throwIfAborted();
    this.root ??= mkdtemp(join(tmpdir(), 'floebrowser-upload-'));
    const root = await this.root;
    const path = join(root, relative);
    const iterator = body[Symbol.asyncIterator]();
    let handle;
    let complete = false;
    try {
      signal.throwIfAborted();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      handle = await open(path, 'wx', 0o600);
      let size = 0;
      while (true) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) break;
        const data = next.value;
        if (
          !(data instanceof Uint8Array) ||
          data.length > 1024 * 1024 ||
          size + data.length > file.size
        )
          throw new Error('Upload byte limit exceeded');
        for (let offset = 0; offset < data.length;) {
          signal.throwIfAborted();
          const { bytesWritten } = await handle.write(data.subarray(offset));
          if (!bytesWritten) throw new Error('Upload write failed');
          offset += bytesWritten;
        }
        size += data.length;
      }
      signal.throwIfAborted();
      if (size !== file.size) throw new Error('Upload is incomplete');
      complete = true;
    } finally {
      await handle?.close();
      if (!complete) {
        // A stalled producer must not hold cancellation or source control.
        void Promise.resolve(iterator.return?.()).catch(() => {});
        await rm(path, { force: true });
      }
    }
  }
  async readyPaths(ids: readonly string[]): Promise<string[]> {
    const relative = this.paths(ids);
    const root = await this.root!;
    return relative.map((path) => join(root, path));
  }
  /** Validate identities without permitting arbitrary source paths. */
  paths(ids: readonly string[]): string[] {
    if (
      this.abort.signal.aborted ||
      this.pending.size ||
      !ids.length ||
      ids.length !== this.entries.size ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Upload selection unavailable');
    const selected = ids.map((id) => {
      const entry = this.entries.get(id);
      if (!entry?.complete) throw new Error('Upload identity unavailable');
      return entry.relative;
    });
    return this.directory ? [this.directoryName] : selected;
  }
  commit(): void {
    if (this.abort.signal.aborted || this.pending.size)
      throw new Error('Upload selection unavailable');
    this.committed = true;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.abort.abort();
    return (this.closing = (async () => {
      await Promise.allSettled(this.pending);
      if (this.root)
        await rm(await this.root, { recursive: true, force: true });
      for (const entry of this.entries.values()) entry.release();
      this.entries.clear();
    })());
  }
}

function validName(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 255 &&
    !/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value) &&
    !/[. ]$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
