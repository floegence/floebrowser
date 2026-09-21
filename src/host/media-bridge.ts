import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { MediaPacketReader, type MediaFrame } from '../shared/media-wire.js';

export type MediaScope = {
  target: string;
  view: string;
  stream: string;
  node: number;
  width: number;
  height: number;
};
export interface MediaSubscription {
  sdp: string;
  close(): Promise<void>;
  requestKeyframe(): Promise<void>;
}
/** Collect only on the source host. Encoded frames leave through the embedding
 * application's independently authorized media carrier, never this adapter. */
export interface SourceMediaBridge {
  open(
    scope: MediaScope,
    offer: string,
    onFrame: (frame: MediaFrame) => void,
    onFailure?: () => void,
  ): Promise<MediaSubscription>;
  close(): Promise<void>;
}
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const scopeKey = (scope: Pick<MediaScope, 'target' | 'view' | 'stream'>) =>
  JSON.stringify([scope.target, scope.view, scope.stream]);

/** Optional standalone adapter. Embedding runtimes can use the Go collector
 * directly. The helper receives control and emits frames on separate pipes. */
export class NativeMediaBridge implements SourceMediaBridge {
  private child: ChildProcess;
  private pending = new Map<string, Pending>();
  private receivers = new Map<
    string,
    { frame: (frame: MediaFrame) => void; failed: () => void }
  >();
  private ended = false;
  private stopped: Promise<void>;
  constructor(executablePath: string) {
    this.child = spawn(executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on('line', (line) => {
      if (line.length > 65536) {
        this.fail();
        return;
      }
      try {
        const result = JSON.parse(line);
        const pending = this.pending.get(result.id);
        if (!pending) return;
        this.pending.delete(result.id);
        clearTimeout(pending.timer);
        if (result.error) pending.reject(new Error('Source media unavailable'));
        else pending.resolve(result);
      } catch {
        this.fail();
      }
    });
    const reader = new MediaPacketReader();
    (this.child.stdio[3] as Readable).on('data', (data: Buffer) => {
      if (this.ended) return;
      try {
        for (const frame of reader.push(data))
          this.receivers.get(scopeKey(frame.header))?.frame(frame);
      } catch {
        this.fail();
      }
    });
    (this.child.stdio[3] as Readable).on('end', () => {
      try {
        reader.finish();
      } catch {
        this.fail();
      }
    });
    this.child.stderr!.resume();
    this.child.on('error', () => this.fail());
    this.child.stdin!.on('error', () => this.fail());
    this.stopped = new Promise((resolve) =>
      this.child.on('close', () => {
        lines.close();
        this.fail();
        resolve();
      }),
    );
  }
  private fail(): void {
    if (this.ended) return;
    this.ended = true;
    const receivers = [...this.receivers.values()];
    this.receivers.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Source media unavailable'));
    }
    this.pending.clear();
    this.child.stdin?.destroy();
    this.child.kill();
    for (const receiver of receivers) {
      try {
        receiver.failed();
      } catch {
        /* Host callback failures stay isolated. */
      }
    }
  }
  private command(
    collector: string,
    op: string,
    fields: Record<string, unknown> = {},
  ): Promise<any> {
    if (this.ended || this.pending.size >= 128)
      return Promise.reject(new Error('Source media unavailable'));
    const id = randomBytes(18).toString('base64url');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Source media unavailable'));
        this.fail();
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(
        JSON.stringify({ id, collector, op, ...fields }) + '\n',
      );
    });
  }
  async open(
    scope: MediaScope,
    offer: string,
    onFrame: (frame: MediaFrame) => void,
    onFailure?: () => void,
  ): Promise<MediaSubscription> {
    const key = scopeKey(scope);
    if (this.receivers.has(key))
      throw new Error('Media stream already subscribed');
    const id = randomBytes(18).toString('base64url');
    let active = true;
    const failed = () => {
      if (!active) return;
      active = false;
      this.receivers.delete(key);
      void this.command(id, 'close').catch(() => {});
      onFailure?.();
    };
    this.receivers.set(key, {
      frame: (frame) => {
        if (active) {
          try {
            onFrame(frame);
          } catch {
            failed();
          }
        }
      },
      failed,
    });
    try {
      const result = await this.command(id, 'open', { scope, sdp: offer });
      let closing: Promise<void> | undefined;
      return {
        sdp: result.sdp,
        close: () => {
          if (closing) return closing;
          active = false;
          this.receivers.delete(key);
          return (closing = this.command(id, 'close').then(() => {}));
        },
        requestKeyframe: async () => {
          if (active) await this.command(id, 'keyframe');
        },
      };
    } catch (error) {
      active = false;
      this.receivers.delete(key);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.fail();
    await this.stopped;
  }
}
