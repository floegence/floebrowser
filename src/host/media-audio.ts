type AudioTrackProcessor = {
  readable: ReadableStream<AudioData>;
};
type AudioTrackGenerator = MediaStreamTrack & {
  writable: WritableStream<AudioData>;
};

/** File-backed Chromium capture copies upcoming output samples but subtracts
 * the output-device delay from their timestamp. Estimate that delay from the
 * lower delivery-age envelope, then restore the samples' presentation time.
 * Stream-backed website tracks already own their timestamps and must bypass
 * this adapter. The native element's routing, mute and volume stay untouched. */
export function captureAudio(
  original: MediaStreamTrack,
  failed: () => void,
): { track: MediaStreamTrack; close(): void } {
  const native = globalThis as unknown as {
    MediaStreamTrackProcessor: new (options: {
      track: MediaStreamTrack;
      maxBufferSize: number;
    }) => AudioTrackProcessor;
    MediaStreamTrackGenerator: new (options: {
      kind: 'audio';
    }) => AudioTrackGenerator;
  };
  const track = new native.MediaStreamTrackGenerator({ kind: 'audio' });
  let reader: ReadableStreamDefaultReader<AudioData>;
  try {
    reader = new native.MediaStreamTrackProcessor({
      track: original,
      maxBufferSize: 1,
    }).readable.getReader();
  } catch (error) {
    track.stop();
    throw error;
  }
  const writer = track.writable.getWriter();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    original.removeEventListener('ended', close);
    original.stop();
    track.stop();
    void reader.cancel().catch(() => {});
    void writer.abort().catch(() => {});
  };
  original.addEventListener('ended', close);
  const ages: number[] = [];
  void (async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        try {
          if (closed) break;
          // One input block and one write are retained. A rolling lower bound
          // rejects dispatch stalls without retaining a session-long calibration
          // after the native output-device latency changes.
          ages.push(performance.now() * 1000 - value.timestamp);
          if (ages.length > 32) ages.shift();
          const delay = Math.max(0, Math.min(...ages));
          const samples = new Float32Array(
            value.numberOfFrames * value.numberOfChannels,
          );
          for (let channel = 0; channel < value.numberOfChannels; channel++)
            value.copyTo(
              samples.subarray(
                channel * value.numberOfFrames,
                (channel + 1) * value.numberOfFrames,
              ),
              { planeIndex: channel, format: 'f32-planar' },
            );
          const corrected = new AudioData({
            format: 'f32-planar',
            sampleRate: value.sampleRate,
            numberOfFrames: value.numberOfFrames,
            numberOfChannels: value.numberOfChannels,
            timestamp: Math.round(value.timestamp + 2 * delay),
            data: samples,
          });
          try {
            await writer.write(corrected);
          } finally {
            corrected.close();
          }
        } finally {
          value.close();
        }
      }
    } catch {
      if (!closed) failed();
    } finally {
      close();
      reader.releaseLock();
      writer.releaseLock();
    }
  })();
  return { track, close };
}
