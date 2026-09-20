import type { MediaPacket, MediaState } from '../shared/protocol.js';

type CaptureElement = HTMLMediaElement & { captureStream(): MediaStream };
type Capture = {
  id: number;
  element: CaptureElement;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  token: string;
  sequence: number;
  pending: number;
  retired: boolean;
  status: MediaState['status'];
  reason: string;
  previous: string;
  src: string;
};

/** Source media elements only. Never captures a display, tab, camera or microphone. */
export function observeMedia(
  doc: Document,
  idFor: (node: Node) => number,
  emit: (packet: MediaPacket) => void,
) {
  const captures = new Map<HTMLMediaElement, Capture>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let enabled = false;
  const release = (capture: Capture) => {
    capture.retired = true;
    if (capture.recorder?.state !== 'inactive') capture.recorder?.stop();
    capture.stream?.getTracks().forEach((track) => track.stop());
  };
  const unavailable = (capture: Capture, reason: string) => {
    release(capture);
    capture.status = 'unavailable';
    capture.reason = reason;
  };
  const start = (capture: Capture) => {
    const element = capture.element;
    if (
      capture.recorder ||
      capture.retired ||
      element.readyState < 2 ||
      element.paused
    )
      return;
    if (element.mediaKeys) {
      unavailable(capture, 'Protected media cannot be forwarded.');
      return;
    }
    try {
      const stream = element.captureStream();
      capture.stream = stream;
      const video = stream.getVideoTracks().length > 0;
      const audio = stream.getAudioTracks().length > 0;
      if (!video && !audio) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mime = video
        ? audio
          ? 'video/webm;codecs=vp8,opus'
          : 'video/webm;codecs=vp8'
        : 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mime)) throw new Error('codec');
      const recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 2_000_000,
        audioBitsPerSecond: 96000,
      });
      const trackIDs = stream
        .getTracks()
        .map((track) => track.id)
        .sort()
        .join(',');
      const changed = () => {
        if (
          !capture.retired &&
          stream
            .getTracks()
            .map((track) => track.id)
            .sort()
            .join(',') !== trackIDs
        ) {
          release(capture);
          captures.delete(element);
        }
      };
      stream.addEventListener('addtrack', changed);
      stream.addEventListener('removetrack', changed);
      capture.recorder = recorder;
      capture.status = 'streaming';
      // Preserve Blob conversion order, and bound work if the binding is slow.
      let queue = Promise.resolve();
      recorder.ondataavailable = (event) => {
        if (capture.retired || !event.data.size) return;
        if (event.data.size > 512 * 1024 || ++capture.pending > 4) {
          unavailable(
            capture,
            'Media exceeded the forwarding buffer. Reload the source to retry.',
          );
          return;
        }
        queue = queue
          .then(async () => {
            const bytes = new Uint8Array(await event.data.arrayBuffer());
            if (capture.retired || !enabled) return;
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192)
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            emit({
              kind: 'chunk',
              id: capture.id,
              stream: capture.token,
              sequence: capture.sequence++,
              mime,
              data: btoa(binary),
            });
          })
          .catch(() => unavailable(capture, 'Media encoding failed.'))
          .finally(() => capture.pending--);
      };
      recorder.onerror = () =>
        unavailable(capture, 'The source browser cannot capture this media.');
      recorder.start(250);
    } catch {
      unavailable(
        capture,
        'This media cannot be captured. It may be protected or restricted by its origin.',
      );
    }
  };
  const scan = () => {
    if (!enabled) return;
    const elements = new Set<HTMLMediaElement>();
    const collect = (root: Document | ShadowRoot) => {
      root
        .querySelectorAll<HTMLMediaElement>('video,audio')
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
        idFor(element) !== capture.id ||
        element.currentSrc !== capture.src
      ) {
        release(capture);
        captures.delete(element);
        emit({ kind: 'removed', id: capture.id });
      }
    }
    for (const element of elements) {
      const id = idFor(element);
      if (id <= 0) continue;
      let capture = captures.get(element);
      if (!capture) {
        if (captures.size >= 8) continue;
        capture = {
          id,
          element: element as CaptureElement,
          token: crypto.getRandomValues(new Uint32Array(4)).join('-'),
          sequence: 0,
          pending: 0,
          retired: false,
          status: 'waiting',
          reason: '',
          previous: '',
          src: element.currentSrc,
        };
        captures.set(element, capture);
      }
      start(capture);
      const state: MediaState = {
        kind: 'state',
        id,
        paused: element.paused,
        time: Math.max(0, element.currentTime || 0),
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        muted: element.muted,
        volume: element.volume,
        status: capture.status,
        reason: capture.reason,
      };
      const encoded = JSON.stringify(state);
      if (encoded !== capture.previous) {
        capture.previous = encoded;
        emit(state);
      }
    }
  };
  return {
    setEnabled(active: boolean) {
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
