/** Playback is independent of source execution. Resuming this context only
 * unlocks client audio; it never invokes play on a source media element. */
export class AudioOutput {
  private context?: AudioContext;
  private module?: Promise<void>;
  private closed = false;
  private clockReady = false;
  private tracks = new Map<
    string,
    { node: AudioWorkletNode; gain: GainNode }
  >();
  private adding = new Set<string>();
  constructor(
    private workletURL: string | URL,
    private blocked: (value: boolean) => void,
  ) {}
  get running(): boolean {
    return this.context?.state === 'running';
  }
  /** Convert an audible presentation deadline to the context's render clock. */
  private presentationLatency(): number {
    if (!this.context || !this.running || !this.clockReady) return 0;
    const clock = this.context.getOutputTimestamp();
    if (!clock.contextTime || !clock.performanceTime) return 0;
    return Math.max(
      0,
      clock.performanceTime +
        (this.context.currentTime - clock.contextTime) * 1000 -
        performance.now(),
    );
  }
  async unlock(): Promise<void> {
    if (this.context?.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        /* The browser owns audio permission. */
      }
      this.blocked(!this.running);
    }
  }
  async add(id: string, consumed: (frames: number) => void): Promise<void> {
    if (this.closed || this.tracks.has(id) || this.adding.has(id)) return;
    this.adding.add(id);
    try {
      this.context ??= new AudioContext({
        sampleRate: 48000,
        latencyHint: 'interactive',
      });
      this.context.onstatechange = () => {
        if (!this.running) this.clockReady = false;
      };
      this.module ??= this.context.audioWorklet.addModule(this.workletURL);
      await this.module;
      if (this.closed || !this.adding.has(id)) return;
      const node = new AudioWorkletNode(this.context, 'floe-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const gain = this.context.createGain();
      gain.gain.value = 0;
      node.connect(gain).connect(this.context.destination);
      node.port.onmessage = ({ data }) => {
        // Query the device clock only after the graph has rendered samples.
        // Firefox can deadlock in its synchronous latency query during startup,
        // even when the context already reports a running, advancing clock.
        if (data.rendered) this.clockReady = true;
        consumed(data.consumed);
      };
      this.tracks.set(id, { node, gain });
      this.blocked(this.context.state !== 'running');
    } finally {
      this.adding.delete(id);
    }
  }
  push(id: string, channels: Float32Array[], delayMs: number): boolean {
    const track = this.tracks.get(id);
    if (!track || !this.context || !this.running) return false;
    track.node.port.postMessage(
      {
        type: 'samples',
        channels,
        at:
          this.context.currentTime +
          Math.max(0, delayMs - this.presentationLatency()) / 1000,
      },
      channels.map((c) => c.buffer),
    );
    return true;
  }
  volume(id: string, volume: number) {
    const track = this.tracks.get(id);
    if (track) track.gain.gain.value = volume;
  }
  remove(id: string): void {
    this.adding.delete(id);
    const track = this.tracks.get(id);
    this.tracks.delete(id);
    if (!track) return;
    track.node.port.postMessage({ type: 'close' });
    track.node.disconnect();
    track.gain.disconnect();
    track.node.port.close();
  }
  close(): void {
    this.closed = true;
    for (const id of this.tracks.keys()) this.remove(id);
    void this.context?.close();
  }
}
