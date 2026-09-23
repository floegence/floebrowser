import { AUDIO_BUFFER_FRAMES } from './media-limits.js';

declare const currentTime: number;
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor,
): void;

type Samples = { channels: Float32Array[]; at: number };
class FloeAudioProcessor extends AudioWorkletProcessor {
  private queue: Samples[] = [];
  private frames = 0;
  private closed = false;
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'close') {
        this.clear();
        this.closed = true;
      } else if (data.type === 'clear') this.clear();
      else if (data.type === 'samples') {
        const item: Samples = data;
        const length = item.channels[0]?.length ?? 0;
        if (
          this.closed ||
          !length ||
          length > AUDIO_BUFFER_FRAMES ||
          !Number.isFinite(item.at) ||
          item.channels.length > 2 ||
          item.channels.some((c) => c.length !== length)
        ) {
          this.port.postMessage({ consumed: length });
          return;
        }
        if (this.frames + length > AUDIO_BUFFER_FRAMES) this.clear();
        this.frames += length;
        this.queue.push(item);
      }
    };
  }
  private clear() {
    this.port.postMessage({ consumed: this.frames });
    this.queue = [];
    this.frames = 0;
  }
  process(_input: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.closed) return false;
    const output = outputs[0];
    if (!output?.[0]) return true;
    const end = currentTime + output[0].length / sampleRate;
    while (this.queue.length) {
      const item = this.queue[0]!;
      const length = item.channels[0]!.length;
      if (item.at >= end) break;
      const start = Math.round((item.at - currentTime) * sampleRate);
      for (let ch = 0; ch < output.length; ch++) {
        const samples = item.channels[Math.min(ch, item.channels.length - 1)]!;
        const target = output[ch]!;
        for (
          let i = Math.max(0, start);
          i < Math.min(target.length, start + length);
          i++
        )
          target[i] = samples[i - start]!;
      }
      if (item.at + length / sampleRate > end) break;
      this.queue.shift();
      this.frames -= length;
      this.port.postMessage({ consumed: length, rendered: true });
    }
    return true;
  }
}
registerProcessor('floe-audio', FloeAudioProcessor);
export {};
