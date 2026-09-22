import type { MediaFrame } from '../shared/media-wire.js';
import type { DecoderEvent } from './media-decoder.js';
import { alignMediaTimestamp, type MediaClock } from './media-clock.js';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage(message: DecoderEvent, transfer?: Transferable[]): void;
};
let video: VideoDecoder | undefined;
let audio: AudioDecoder | undefined;
let videoConfiguration = '';
let needsKey = true;
let painting = false;
let latest: VideoFrame | undefined;
let audioFrames = 0;
const MAX_DECODE_FAILURES = 3;
let videoFailures = 0;
let audioFailures = 0;
const mediaClock: MediaClock = {};
let firstAudioInputTimestamp: number | undefined;
let audioDecodeOffset: number | undefined;
const unavailable = new Set<'video' | 'audio'>();
const send = (event: DecoderEvent, transfer?: Transferable[]) =>
  scope.postMessage(event, transfer);

function resetVideo() {
  // WebCodecs closes itself before invoking the asynchronous error callback.
  if (video && video.state !== 'closed') video.close();
  video = undefined;
  videoConfiguration = '';
  needsKey = true;
  latest?.close();
  latest = undefined;
}

function failed(track: 'video' | 'audio', error?: unknown) {
  if (unavailable.has(track)) return;
  if (track === 'video') resetVideo();
  else {
    if (audio && audio.state !== 'closed') audio.close();
    audio = undefined;
    firstAudioInputTimestamp = undefined;
    audioDecodeOffset = undefined;
  }
  const count = track === 'video' ? ++videoFailures : ++audioFailures;
  const unsupported =
    !error ||
    (error instanceof DOMException && error.name === 'NotSupportedError');
  if (unsupported || count >= MAX_DECODE_FAILURES) {
    unavailable.add(track);
    send({ type: 'unavailable', track });
  } else if (track === 'video') send({ type: 'keyframe' });
  // Opus packets are independently decodable; the next packet can recover audio.
}

function paint(frame: VideoFrame) {
  if (painting) {
    latest?.close();
    latest = frame;
    return;
  }
  painting = true;
  send({ type: 'video', frame }, [frame]);
}

function videoCodec(frame: MediaFrame): string {
  if (frame.header.codec === 'vp8') return 'vp8';
  // H.264 access units use Annex B. Its SPS describes the negotiated profile,
  // compatibility flags and level; no browser-specific profile guess is needed.
  const bytes = frame.data;
  for (let i = 2; i + 4 < bytes.length; i++)
    if (
      bytes[i - 2] === 0 &&
      bytes[i - 1] === 0 &&
      bytes[i] === 1 &&
      (bytes[i + 1]! & 31) === 7
    )
      return (
        'avc1.' +
        [...bytes.subarray(i + 2, i + 5)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      );
  return videoConfiguration.split(':')[0] || '';
}

function decode(frame: MediaFrame) {
  const h = frame.header;
  if (h.track === 'canvas' || unavailable.has(h.track)) return;
  const timestamp = alignMediaTimestamp(mediaClock, h.track, h.timestamp_us);
  if (h.track === 'video') {
    if (typeof VideoDecoder !== 'function') {
      failed('video');
      return;
    }
    if (video && video.decodeQueueSize >= 6) {
      resetVideo();
      send({ type: 'keyframe' });
    }
    if (needsKey && !h.keyframe) return;
    const codec = videoCodec(frame);
    const configuration = `${codec}:${h.width}:${h.height}`;
    if (configuration !== videoConfiguration) {
      resetVideo();
      if (!h.keyframe || !codec) {
        send({ type: 'keyframe' });
        return;
      }
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (video !== decoder) {
            frame.close();
            return;
          }
          videoFailures = 0;
          paint(frame);
        },
        error: (error) => {
          if (video === decoder) failed('video', error);
        },
      });
      video = decoder;
      video.configure({
        codec,
        codedWidth: h.width,
        codedHeight: h.height,
        optimizeForLatency: true,
      });
      videoConfiguration = configuration;
    }
    video!.decode(
      new EncodedVideoChunk({
        type: h.keyframe ? 'key' : 'delta',
        timestamp,
        duration: h.duration_us || undefined,
        data: frame.data,
      }),
    );
    needsKey = false;
  } else if (h.track === 'audio') {
    if (typeof AudioDecoder !== 'function') {
      failed('audio');
      return;
    }
    if (!audio) {
      const decoder = new AudioDecoder({
        output: (data) => {
          try {
            if (audio !== decoder) return;
            audioFailures = 0;
            // Bound even the Worker -> main -> worklet path while the UI is busy.
            if (audioFrames + data.numberOfFrames > 12000) return;
            const channels = Array.from(
              { length: data.numberOfChannels },
              (_, planeIndex) => {
                const samples = new Float32Array(data.numberOfFrames);
                data.copyTo(samples, { planeIndex, format: 'f32-planar' });
                return samples;
              },
            );
            audioFrames += data.numberOfFrames;
            audioDecodeOffset ??=
              (firstAudioInputTimestamp ?? data.timestamp) - data.timestamp;
            send(
              {
                type: 'audio',
                channels,
                timestamp: data.timestamp + audioDecodeOffset,
                rate: data.sampleRate,
              },
              channels.map((c) => c.buffer),
            );
          } finally {
            data.close();
          }
        },
        error: (error) => {
          if (audio === decoder) failed('audio', error);
        },
      });
      audio = decoder;
      audio.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
      });
    }
    if (audio.decodeQueueSize < 12) {
      firstAudioInputTimestamp ??= timestamp;
      audio.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp,
          duration: h.duration_us || undefined,
          data: frame.data,
        }),
      );
    }
  }
}

scope.onmessage = ({ data }) => {
  if (data.type === 'frame') {
    try {
      decode(data.frame);
    } catch (error) {
      failed(data.frame.header.track, error);
    } finally {
      send({ type: 'accepted' });
    }
  } else if (data.type === 'reset-video') resetVideo();
  else if (data.type === 'painted') {
    painting = false;
    if (latest) {
      const frame = latest;
      latest = undefined;
      paint(frame);
    }
  } else if (data.type === 'audio-consumed')
    audioFrames = Math.max(0, audioFrames - data.frames);
};
