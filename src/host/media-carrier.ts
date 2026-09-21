import {
  encodeMediaFrame,
  MEDIA_STREAM_CHUNK_BYTES,
  type MediaFrame,
  type MediaFrameHeader,
} from '../shared/media-wire.js';

type Lane = {
  queue: Array<{ frame: MediaFrame; at: number }>;
  needKey: boolean;
  requested: number;
};
export type MediaSenderLimits = {
  windowPackets?: number;
  windowBytes?: number;
  queuedPackets?: number;
  queuedBytes?: number;
  ageMs?: number;
};

/** Credit is returned only after complete frames reach the consumer. Bounded
 * lanes drop video dependencies together; this writer never owns control input. */
export class MediaSender {
  private lanes = new Map<string, Lane>();
  private inflight = new Map<number, number>();
  private sequence = 0;
  private acknowledged = 0;
  private bytes = 0;
  private queuedBytes = 0;
  private last = '';
  private writing = false;
  private closed = false;
  private limits: Required<MediaSenderLimits>;
  constructor(
    private write: (chunk: Uint8Array) => Promise<void>,
    private keyframe: (scope: MediaFrameHeader) => void,
    limits: MediaSenderLimits = {},
  ) {
    this.limits = {
      windowPackets: 8,
      windowBytes: 256 * 1024,
      queuedPackets: 8,
      queuedBytes: 4 * 1024 * 1024,
      ageMs: 250,
      ...limits,
    };
    if (
      Object.values(this.limits).some((v) => !Number.isSafeInteger(v) || v <= 0)
    )
      throw new Error('Invalid media sender limits');
  }
  push(frame: MediaFrame): void {
    if (this.closed) return;
    const h = frame.header;
    const key = JSON.stringify([h.target, h.view, h.stream, h.track]);
    let lane = this.lanes.get(key);
    if (!lane) {
      if (this.lanes.size >= 64) return;
      lane = { queue: [], needKey: h.track === 'video', requested: -Infinity };
      this.lanes.set(key, lane);
    }
    if (
      h.track === 'canvas' ||
      lane.queue.length >= this.limits.queuedPackets ||
      (lane.queue[0] &&
        performance.now() - lane.queue[0].at > this.limits.ageMs)
    )
      this.discard(lane);
    if (this.queuedBytes + frame.data.length > this.limits.queuedBytes) {
      this.discard(lane);
      if (h.track === 'video') this.request(lane, h);
      return;
    }
    if (h.track === 'video' && lane.needKey && !h.keyframe) {
      this.request(lane, h);
      return;
    }
    if (h.track === 'video') lane.needKey = false;
    lane.queue.push({ frame, at: performance.now() });
    this.queuedBytes += frame.data.length;
    void this.pump();
  }
  acknowledge(sequence: number): boolean {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < this.acknowledged ||
      sequence > this.sequence
    )
      return false;
    this.acknowledged = sequence;
    for (const [id, length] of this.inflight)
      if (id <= sequence) {
        this.bytes -= length;
        this.inflight.delete(id);
      }
    void this.pump();
    return true;
  }
  retire(target: string, view?: string, stream?: string): void {
    for (const [key, lane] of this.lanes) {
      const [t, v, s] = JSON.parse(key);
      if (
        t === target &&
        (view === undefined || v === view) &&
        (stream === undefined || s === stream)
      ) {
        this.discard(lane);
        this.lanes.delete(key);
      }
    }
  }
  private discard(lane: Lane) {
    for (const { frame } of lane.queue) this.queuedBytes -= frame.data.length;
    lane.queue = [];
    lane.needKey = true;
  }
  private request(lane: Lane, header: MediaFrameHeader) {
    const now = performance.now();
    if (now - lane.requested < 150) return;
    lane.requested = now;
    this.keyframe(header);
  }
  private async pump(): Promise<void> {
    if (this.writing || this.closed) return;
    this.writing = true;
    try {
      while (
        !this.closed &&
        this.inflight.size < this.limits.windowPackets &&
        this.bytes < this.limits.windowBytes
      ) {
        const keys = [...this.lanes.keys()];
        const start = keys.indexOf(this.last) + 1;
        let item: { frame: MediaFrame; at: number } | undefined;
        for (let n = 0; n < keys.length; n++) {
          const key = keys[(start + n) % keys.length]!;
          const lane = this.lanes.get(key)!;
          const first = lane.queue[0];
          if (!first) continue;
          if (
            first.frame.header.track !== 'canvas' &&
            performance.now() - first.at > this.limits.ageMs
          ) {
            this.discard(lane);
            if (first.frame.header.track === 'video')
              this.request(lane, first.frame.header);
            continue;
          }
          item = lane.queue.shift()!;
          this.queuedBytes -= item.frame.data.length;
          this.last = key;
          break;
        }
        if (!item) break;
        const packet = encodeMediaFrame(item.frame.header, item.frame.data);
        this.inflight.set(++this.sequence, packet.length);
        this.bytes += packet.length;
        for (
          let offset = 0;
          offset < packet.length && !this.closed;
          offset += MEDIA_STREAM_CHUNK_BYTES
        )
          await this.write(
            packet.subarray(offset, offset + MEDIA_STREAM_CHUNK_BYTES),
          );
      }
    } catch {
      this.close();
    } finally {
      this.writing = false;
    }
  }
  close(): void {
    this.closed = true;
    this.lanes.clear();
    this.inflight.clear();
    this.queuedBytes = this.bytes = 0;
  }
}
