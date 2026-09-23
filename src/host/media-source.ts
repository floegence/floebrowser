import { observeCanvas } from './canvas-source.js';
import { captureAudio } from './media-audio.js';
import {
  CANVAS_CHANNEL,
  CANVAS_CHUNK_BYTES,
  CANVAS_HEADER_BYTES,
  MAX_CANVAS_BYTES,
} from '../shared/canvas.js';
import type { SourceMediaPacket, MediaState } from '../shared/protocol.js';

type CaptureElement =
  (HTMLMediaElement & { captureStream(): MediaStream }) | HTMLCanvasElement;
type CaptureHeaderExtension = {
  uri: string;
  direction: RTCRtpTransceiverDirection;
};
type CaptureTransceiver = RTCRtpTransceiver & {
  getHeaderExtensionsToNegotiate?(): CaptureHeaderExtension[];
  setHeaderExtensionsToNegotiate?(extensions: CaptureHeaderExtension[]): void;
};
const CAPTURE_TIME_URI =
  'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';
const isCanvas = (element: CaptureElement): element is HTMLCanvasElement =>
  element.localName === 'canvas';
type Capture = {
  id: number;
  element: CaptureElement;
  stream?: MediaStream;
  peer?: RTCPeerConnection;
  token: string;
  retired: boolean;
  status: MediaState['status'];
  reason: string;
  playbackError?: string;
  previous: string;
  src: string;
  sourceObject: HTMLMediaElement['srcObject'] | string;
  offer?: string;
  negotiating: boolean;
  retries: number;
  stopWatching?: () => void;
  stopAudio?: () => void;
  pictureUpdate?: Promise<void>;
};

/** Captures only source media elements. RTP congestion control drops late frames;
 * encoded media never enters rrweb, CDP bindings or the DOM/control carrier. */
export function observeMedia(
  doc: Document,
  key: string,
  idFor: (node: Node) => number,
  emit: (packet: SourceMediaPacket) => void,
) {
  const captures = new Map<CaptureElement, Capture>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let enabled = false;
  let pictures = true;
  const updatePictures = (capture: Capture) => {
    if (capture.pictureUpdate || !capture.peer || capture.retired) return;
    const active = pictures;
    capture.pictureUpdate = (async () => {
      for (const sender of capture.peer!.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) continue;
        for (const encoding of parameters.encodings) encoding.active = active;
        await sender.setParameters(parameters);
      }
    })()
      .catch(() => {})
      .finally(() => {
        capture.pictureUpdate = undefined;
        if (active !== pictures) updatePictures(capture);
      });
  };
  const sourceObject = (element: CaptureElement) => {
    const source = isCanvas(element) ? null : element.srcObject;
    // Chromium can return a new MediaStream wrapper for the same source.
    return source && 'id' in source ? source.id : source;
  };
  const release = (capture: Capture) => {
    capture.retired = true;
    capture.stopWatching?.();
    capture.stopAudio?.();
    capture.peer?.close();
    capture.stream?.getTracks().forEach((track) => track.stop());
    delete (capture.element as any)[key];
  };
  const unavailable = (capture: Capture, reason: string) => {
    release(capture);
    capture.status = 'unavailable';
    capture.reason = reason;
  };
  const negotiate = async (capture: Capture, restart = false) => {
    const peer = capture.peer;
    if (!peer || capture.retired || capture.negotiating) return;
    capture.negotiating = true;
    try {
      capture.status = 'connecting';
      await peer.setLocalDescription(
        await peer.createOffer({ iceRestart: restart }),
      );
      if (peer.iceGatheringState !== 'complete')
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timeout);
            peer.removeEventListener('icegatheringstatechange', changed);
            resolve();
          };
          const changed = () => {
            if (peer.iceGatheringState === 'complete' || capture.retired)
              finish();
          };
          const timeout = setTimeout(finish, 3000);
          peer.addEventListener('icegatheringstatechange', changed);
          changed();
        });
      if (capture.retired || !enabled) return;
      capture.offer = peer.localDescription!.sdp;
      emit({
        kind: 'offer',
        id: capture.id,
        stream: capture.token,
        sdp: capture.offer,
      });
    } catch {
      if (!capture.retired)
        unavailable(
          capture,
          'The source could not establish the media connection.',
        );
    } finally {
      capture.negotiating = false;
    }
  };
  const connection = (capture: Capture) => {
    const peer = capture.peer!;
    peer.onconnectionstatechange = () => {
      if (capture.retired) return;
      if (peer.connectionState === 'connected') {
        capture.status = 'streaming';
        capture.retries = 0;
      } else if (peer.connectionState === 'disconnected')
        capture.status = 'connecting';
      else if (peer.connectionState === 'failed') {
        if (capture.retries++ < 2) void negotiate(capture, true);
        else unavailable(capture, 'Source media collection was interrupted.');
      }
    };
  };
  const start = (capture: Capture) => {
    const element = capture.element;
    if (capture.peer || capture.retired) return;
    if (isCanvas(element)) {
      if (!element.width || !element.height || !element.checkVisibility())
        return;
      const peer = new RTCPeerConnection({ iceServers: [] });
      capture.peer = peer;
      const channel = peer.createDataChannel(CANVAS_CHANNEL, {
        ordered: false,
        maxRetransmits: 0,
      });
      const canvas = observeCanvas(
        doc.defaultView as Window & typeof globalThis,
        `${key}:canvas`,
      );
      let encoding = false;
      let sent = 0;
      let sequence = 0;
      let sentAt = 0;
      let encoded: { revision: number; bytes: Uint8Array } | undefined;
      const send = async () => {
        if (
          capture.retired ||
          !enabled ||
          !pictures ||
          encoding ||
          channel.readyState !== 'open' ||
          channel.bufferedAmount
        )
          return;
        const surface = canvas.get(element);
        if (
          !surface ||
          (surface.revision === sent && performance.now() - sentAt < 1000)
        )
          return;
        encoding = true;
        const revision = surface.revision;
        const { width, height } = surface;
        try {
          if (surface.error) throw new Error(surface.error);
          if (encoded?.revision !== revision) {
            const blob = await surface.bitmap.convertToBlob({
              type: 'image/webp',
              quality: 0.8,
            });
            encoded = {
              revision,
              bytes: new Uint8Array(await blob.arrayBuffer()),
            };
          }
          const bytes = encoded.bytes;
          if (
            capture.retired ||
            !enabled ||
            !pictures ||
            channel.readyState !== 'open'
          )
            return;
          if (bytes.length > MAX_CANVAS_BYTES)
            throw new Error('Canvas frame exceeds the graphics limit.');
          const id = ++sequence;
          for (
            let offset = 0;
            offset < bytes.length;
            offset += CANVAS_CHUNK_BYTES
          ) {
            const data = bytes.subarray(offset, offset + CANVAS_CHUNK_BYTES);
            const packet = new Uint8Array(CANVAS_HEADER_BYTES + data.length);
            const header = new DataView(packet.buffer);
            [id, width, height, bytes.length, offset].forEach((value, index) =>
              header.setUint32(index * 4, value),
            );
            packet.set(data, CANVAS_HEADER_BYTES);
            channel.send(packet);
          }
          sent = revision;
          sentAt = performance.now();
        } catch {
          if (!capture.retired)
            unavailable(
              capture,
              'This canvas cannot be forwarded. Its origin or graphics format may restrict access.',
            );
        } finally {
          encoding = false;
        }
      };
      const timer = setInterval(() => void send(), 42);
      channel.onopen = () => {
        capture.status = 'streaming';
        void send();
      };
      channel.onerror = () => {
        if (!capture.retired)
          unavailable(capture, 'The canvas connection was interrupted.');
      };
      capture.stopWatching = () => {
        clearInterval(timer);
        channel.close();
      };
      connection(capture);
      void negotiate(capture);
      return;
    }
    if (element.readyState < 2) return;
    if (element.mediaKeys) {
      unavailable(capture, 'Protected media cannot be forwarded.');
      return;
    }
    try {
      const sourceObject = element.srcObject;
      const borrowed =
        sourceObject && 'getTracks' in sourceObject ? sourceObject : undefined;
      // Recapturing a stream-backed element replaces Chromium's original track
      // wrappers. Collecting a Canvas track wrapper can then stop the website's
      // producer. Borrow its existing stream and own only cloned tracks.
      const observed = borrowed ?? element.captureStream();
      const stream = borrowed
        ? new MediaStream(observed.getTracks().map((track) => track.clone()))
        : new MediaStream(observed.getTracks());
      capture.stream = stream;
      if (!stream.getTracks().length) return;
      if (!borrowed) {
        const audio: ReturnType<typeof captureAudio>[] = [];
        capture.stopAudio = () => audio.forEach((item) => item.close());
        for (const original of stream.getAudioTracks()) {
          const projected = captureAudio(original, () => {
            if (!capture.retired)
              unavailable(capture, 'Source audio capture was interrupted.');
          });
          audio.push(projected);
          stream.removeTrack(original);
          stream.addTrack(projected.track);
        }
      }
      const peer = new RTCPeerConnection({ iceServers: [] });
      capture.peer = peer;
      for (const track of stream.getTracks()) {
        const video = track.kind === 'video';
        const width =
          (element as unknown as HTMLVideoElement).videoWidth || 1280;
        const transceiver = peer.addTransceiver(track, {
          direction: 'sendonly',
          streams: [stream],
          sendEncodings: [
            video
              ? {
                  active: pictures,
                  maxBitrate: 1_500_000,
                  maxFramerate: 24,
                  scaleResolutionDownBy: Math.max(1, width / 1280),
                }
              : { maxBitrate: 64000 },
          ],
        });
        // Audio RTP counts encoded samples even when the native capture clock
        // changes. Carry its current mapping with the affected packet instead
        // of waiting for a periodic RTCP sender report.
        const timing = transceiver as CaptureTransceiver;
        const extensions = timing.getHeaderExtensionsToNegotiate?.();
        if (
          !timing.setHeaderExtensionsToNegotiate ||
          !extensions?.some((extension) => extension.uri === CAPTURE_TIME_URI)
        ) {
          unavailable(
            capture,
            'Update the source browser to support synchronized media capture.',
          );
          return;
        }
        timing.setHeaderExtensionsToNegotiate(
          extensions.map((extension) => ({
            ...extension,
            direction:
              extension.uri === CAPTURE_TIME_URI
                ? 'sendonly'
                : extension.direction,
          })),
        );
      }
      const tracks = () =>
        observed
          .getTracks()
          .map((track) => track.id)
          .sort()
          .join(',');
      const trackIDs = tracks();
      const changed = () => {
        if (!capture.retired && tracks() !== trackIDs) {
          release(capture);
          captures.delete(element);
        }
      };
      observed.addEventListener('addtrack', changed);
      observed.addEventListener('removetrack', changed);
      capture.stopWatching = () => {
        observed.removeEventListener('addtrack', changed);
        observed.removeEventListener('removetrack', changed);
      };
      connection(capture);
      void negotiate(capture);
    } catch {
      unavailable(
        capture,
        'This media cannot be captured. It may be protected or restricted by its origin.',
      );
    }
  };
  const scan = (force = false) => {
    if (!enabled) return;
    const elements = new Set<CaptureElement>();
    const collect = (root: Document | ShadowRoot) => {
      root
        .querySelectorAll<CaptureElement>('video,audio,canvas')
        .forEach((element) => elements.add(element));
      root.querySelectorAll('*').forEach((element) => {
        if (element.shadowRoot) collect(element.shadowRoot);
      });
    };
    collect(doc);
    for (const [element, capture] of captures) {
      if (
        !elements.has(element) ||
        !element.isConnected ||
        (isCanvas(element) && !element.checkVisibility()) ||
        (!isCanvas(element) && element.currentSrc !== capture.src) ||
        sourceObject(element) !== capture.sourceObject
      ) {
        release(capture);
        captures.delete(element);
        // A source replacement retains the element identity. Its fresh state
        // atomically replaces the old stream; a false DOM removal would close
        // an open media panel and transiently erase the source's controls.
        if (!elements.has(element) || !element.isConnected || isCanvas(element))
          emit({ kind: 'removed', id: capture.id });
      }
    }
    for (const element of elements) {
      if (
        isCanvas(element) &&
        (!element.width || !element.height || !element.checkVisibility())
      )
        continue;
      const id = idFor(element);
      if (id <= 0) continue;
      let capture = captures.get(element);
      if (!capture) {
        if (captures.size >= 8) continue;
        capture = {
          id,
          element: element as CaptureElement,
          token: crypto.getRandomValues(new Uint32Array(4)).join('-'),
          retired: false,
          status: 'waiting',
          reason: '',
          previous: '',
          src: isCanvas(element) ? '' : element.currentSrc,
          sourceObject: sourceObject(element),
          negotiating: false,
          retries: 0,
        };
        captures.set(element, capture);
        const current = capture;
        (element as any)[key] = {
          captureFailed: (token: string) => {
            if (!current.retired && current.token === token)
              unavailable(current, 'Source media collection is unavailable.');
          },
          answer: async (token: string, sdp: string) => {
            if (
              current.retired ||
              token !== current.token ||
              current.peer?.signalingState !== 'have-local-offer'
            )
              return;
            await current.peer.setRemoteDescription({ type: 'answer', sdp });
          },
          playbackFailed: () => {
            if (!current.retired)
              current.playbackError =
                'The source browser could not start playback. Use the page’s play control or reload the source.';
          },
        };
      }
      capture.id = id;
      start(capture);
      if (!isCanvas(element) && !element.paused && element.readyState >= 3)
        capture.playbackError = '';
      const state: MediaState = {
        kind: 'state',
        id,
        stream: capture.token,
        paused: isCanvas(element) ? false : element.paused,
        time: isCanvas(element) ? 0 : Math.max(0, element.currentTime || 0),
        duration:
          !isCanvas(element) && Number.isFinite(element.duration)
            ? element.duration
            : 0,
        muted: isCanvas(element) || element.muted,
        volume: isCanvas(element) ? 0 : element.volume,
        status: capture.status,
        reason: capture.reason || capture.playbackError || '',
      };
      const serialized = JSON.stringify(state);
      if (force || serialized !== capture.previous) {
        capture.previous = serialized;
        emit(state);
      }
      if (
        force &&
        capture.offer &&
        capture.peer?.signalingState === 'have-local-offer'
      )
        emit({ kind: 'offer', id, stream: capture.token, sdp: capture.offer });
    }
  };
  return {
    retire(streams: string[]) {
      for (const [element, capture] of captures) {
        if (!streams.includes(capture.token)) continue;
        release(capture);
        captures.delete(element);
        emit({ kind: 'removed', id: capture.id });
      }
    },
    setEnabled(active: boolean, visible = true) {
      if (pictures !== visible) {
        pictures = visible;
        for (const capture of captures.values()) updatePictures(capture);
      }
      if (active === enabled) {
        if (active) scan(true);
        return;
      }
      enabled = active;
      if (timer) clearInterval(timer);
      for (const capture of captures.values()) release(capture);
      captures.clear();
      if (enabled) {
        scan();
        timer = setInterval(scan, 500);
      }
    },
    close() {
      enabled = false;
      if (timer) clearInterval(timer);
      for (const capture of captures.values()) release(capture);
      captures.clear();
    },
  };
}
