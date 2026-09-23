import type { MediaFrame } from '../shared/media-wire.js';

export type DecoderEvent =
  | { type: 'video'; frame: VideoFrame; generation: number }
  | { type: 'audio'; channels: Float32Array[]; timestamp: number; rate: number }
  | { type: 'accepted' }
  | { type: 'keyframe' }
  | { type: 'unavailable'; track: 'audio' | 'video' };

/** One bounded worker per element. This owns codecs only, never a source URL or
 * RTC connection. The host remains responsible for subscription authorization. */
export class ElementDecoder {
  private worker: Worker;
  private pending = 0;
  private closed = false;
  private needKey = true;
  private videoGeneration = 0;
  private unavailable = new Set<'audio' | 'video'>();
  constructor(
    workerURL: string | URL,
    private output: (event: DecoderEvent) => void,
  ) {
    this.worker = new Worker(workerURL, { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<DecoderEvent>) => {
      if (this.closed) {
        if (data.type === 'video') data.frame.close();
        return;
      }
      if (data.type === 'accepted')
        this.pending = Math.max(0, this.pending - 1);
      else {
        if (data.type === 'video' && data.generation !== this.videoGeneration) {
          data.frame.close();
          this.painted();
          return;
        }
        if (data.type === 'keyframe') this.needKey = true;
        if (data.type === 'unavailable') this.unavailable.add(data.track);
        this.output(data);
      }
    };
    this.worker.onerror = () => {
      this.output({ type: 'unavailable', track: 'video' });
      this.output({ type: 'unavailable', track: 'audio' });
      this.close();
    };
  }
  push(frame: MediaFrame): void {
    if (
      this.closed ||
      frame.header.track === 'canvas' ||
      this.unavailable.has(frame.header.track)
    )
      return;
    const video = frame.header.track === 'video';
    if (this.pending >= 8) {
      if (video && !this.needKey) {
        this.resetVideo();
        this.output({ type: 'keyframe' });
      }
      return;
    }
    if (video && this.needKey && !frame.header.keyframe) return;
    if (video) this.needKey = false;
    // Transfer a dedicated allocation: host carriers may share input buffers.
    const data = frame.data.slice();
    this.pending++;
    this.worker.postMessage(
      { type: 'frame', frame: { header: frame.header, data } },
      [data.buffer],
    );
  }
  resetVideo(): void {
    if (this.closed) return;
    this.needKey = true;
    this.worker.postMessage({
      type: 'reset-video',
      generation: ++this.videoGeneration,
    });
  }
  painted(): void {
    if (!this.closed) this.worker.postMessage({ type: 'painted' });
  }
  audioConsumed(frames: number): void {
    if (!this.closed)
      this.worker.postMessage({ type: 'audio-consumed', frames });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
  }
}
