import type {
  MediaConfiguration,
  MediaPacket,
  MediaState,
} from '../shared/protocol.js';

type CaptureElement = HTMLMediaElement & { captureStream(): MediaStream };
type Capture = {
  id: number;
  element: CaptureElement;
  stream?: MediaStream;
  peer?: RTCPeerConnection;
  token: string;
  retired: boolean;
  status: MediaState['status'];
  reason: string;
  previous: string;
  src: string;
  offer?: string;
  negotiating: boolean;
  retries: number;
};

/** Captures only source media elements. RTP congestion control drops late frames;
 * encoded media never enters rrweb, CDP bindings or the DOM/control carrier. */
export function observeMedia(
  doc: Document,
  key: string,
  configuration: MediaConfiguration,
  idFor: (node: Node) => number,
  emit: (packet: MediaPacket) => void,
) {
  const captures = new Map<HTMLMediaElement, Capture>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let enabled = false;
  const release = (capture: Capture) => {
    capture.retired = true;
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
  const start = (capture: Capture) => {
    const element = capture.element;
    if (capture.peer || capture.retired || element.readyState < 2) return;
    if (element.mediaKeys) {
      unavailable(capture, 'Protected media cannot be forwarded.');
      return;
    }
    try {
      const stream = element.captureStream();
      capture.stream = stream;
      if (!stream.getTracks().length) return;
      const peer = new RTCPeerConnection(configuration);
      capture.peer = peer;
      for (const track of stream.getTracks()) {
        const video = track.kind === 'video';
        const width =
          (element as unknown as HTMLVideoElement).videoWidth || 1280;
        peer.addTransceiver(track, {
          direction: 'sendonly',
          streams: [stream],
          sendEncodings: [
            video
              ? {
                  maxBitrate: 1_500_000,
                  maxFramerate: 24,
                  scaleResolutionDownBy: Math.max(1, width / 1280),
                }
              : { maxBitrate: 64000 },
          ],
        });
      }
      const tracks = () =>
        stream
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
      stream.addEventListener('addtrack', changed);
      stream.addEventListener('removetrack', changed);
      (element as any)[key] = {
        answer: async (token: string, sdp: string) => {
          if (
            capture.retired ||
            token !== capture.token ||
            peer.signalingState !== 'have-local-offer'
          )
            return;
          await peer.setRemoteDescription({ type: 'answer', sdp });
        },
      };
      peer.onconnectionstatechange = () => {
        if (capture.retired) return;
        if (peer.connectionState === 'connected') {
          capture.status = 'streaming';
          capture.retries = 0;
        } else if (peer.connectionState === 'disconnected')
          capture.status = 'connecting';
        else if (peer.connectionState === 'failed') {
          if (capture.retries++ < 2) void negotiate(capture, true);
          else
            unavailable(
              capture,
              'Media connection failed. Check the source network or TURN relay configuration.',
            );
        }
      };
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
          retired: false,
          status: 'waiting',
          reason: '',
          previous: '',
          src: element.currentSrc,
          negotiating: false,
          retries: 0,
        };
        captures.set(element, capture);
      }
      capture.id = id;
      start(capture);
      const state: MediaState = {
        kind: 'state',
        id,
        stream: capture.token,
        paused: element.paused,
        time: Math.max(0, element.currentTime || 0),
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        muted: element.muted,
        volume: element.volume,
        status: capture.status,
        reason: capture.reason,
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
    setEnabled(active: boolean) {
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
