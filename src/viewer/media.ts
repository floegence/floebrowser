import { CANVAS_ATTRIBUTE } from '../shared/style.js';
import { CANVAS_CHANNEL, CanvasFrames } from '../shared/canvas.js';
import type {
  Action,
  MediaConfiguration,
  MediaPacket,
  MediaState,
} from '../shared/protocol.js';

type Playback = {
  id: number;
  peer?: RTCPeerConnection;
  stream?: MediaStream;
  element?: HTMLMediaElement;
  canvasURL?: string;
  canvasImage?: string;
  canvasSize?: string;
  canvasBytes?: Uint8Array;
  canvasAnimation?: number;
  canvas?: HTMLImageElement;
  channel?: RTCDataChannel;
  offer?: string;
  answer?: string;
  negotiating: boolean;
  failed?: boolean;
  closed: boolean;
};

/** Media uses a separate encrypted realtime connection. The browser's jitter
 * buffer discards late frames without blocking DOM or input transport. */
export class MediaView {
  private states = new Map<number, MediaState>();
  private playback = new Map<string, Playback>();
  private rows = new Map<
    number,
    {
      root: HTMLElement;
      label: HTMLElement;
      play: HTMLButtonElement;
      seek: HTMLInputElement;
    }
  >();
  private controls = document.createElement('div');
  private toggle = document.createElement('button');
  private panel = document.createElement('div');
  private sound = document.createElement('button');
  private list = document.createElement('div');
  private audible = true;
  private soundBlocked = false;
  private configuration: MediaConfiguration = {};
  private timer: ReturnType<typeof setInterval>;
  constructor(
    container: HTMLElement | undefined,
    private node: (id: number) => Node | null | undefined,
    private dispatch: (action: Action) => Promise<boolean>,
    private answer: (node: number, stream: string, sdp: string) => void,
  ) {
    this.controls.className = 'floe-media-controls';
    this.controls.hidden = true;
    this.toggle.type = 'button';
    this.toggle.className = 'floe-media-toggle';
    this.toggle.setAttribute('aria-label', 'Media controls');
    this.toggle.setAttribute('aria-haspopup', 'dialog');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.innerHTML =
      '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h9M3 9h6M3 13h5M12 7l5 3-5 3V7Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    this.panel.className = 'floe-media-panel';
    this.panel.popover = 'auto';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Media controls');
    this.toggle.popoverTargetElement = this.panel;
    this.panel.addEventListener('toggle', () => {
      const open = this.panel.matches(':popover-open');
      this.toggle.setAttribute('aria-expanded', String(open));
      if (open) {
        const rect = this.toggle.getBoundingClientRect();
        this.panel.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
        this.panel.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - this.panel.offsetHeight - 8))}px`;
        this.sound.focus();
      }
    });
    this.panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.dismiss();
      this.toggle.focus();
    });
    this.sound.type = 'button';
    this.sound.onclick = () => {
      this.audible = this.soundBlocked || !this.audible;
      this.soundBlocked = false;
      for (const playback of this.playback.values()) this.volume(playback);
      this.renderControls();
    };
    this.panel.append(this.sound, this.list);
    this.controls.append(this.toggle, this.panel);
    container?.append(this.controls);
    this.timer = setInterval(() => this.update(), 100);
  }
  configure(configuration: MediaConfiguration) {
    this.configuration = configuration;
  }
  receive(packet: MediaPacket) {
    if (packet.kind === 'removed') {
      this.remove(packet.id);
      return;
    }
    for (const [token, playback] of this.playback)
      if (playback.id === packet.id && token !== packet.stream)
        this.release(token);
    if (packet.kind === 'state') {
      if (!this.states.has(packet.id) && this.states.size >= 8) return;
      const playback = this.playback.get(packet.stream);
      if (playback && playback.id !== packet.id) {
        this.states.delete(playback.id);
        this.rows.get(playback.id)?.root.remove();
        this.rows.delete(playback.id);
        playback.id = packet.id;
      }
      this.states.set(packet.id, packet);
      this.renderControls();
      if (playback) this.volume(playback);
      return;
    }
    void this.offer(packet);
  }
  private async offer(packet: Extract<MediaPacket, { kind: 'offer' }>) {
    let playback = this.playback.get(packet.stream);
    if (!playback) {
      if (this.playback.size >= 8) return;
      playback = { id: packet.id, negotiating: false, closed: false };
      this.playback.set(packet.stream, playback);
    }
    if (playback.negotiating) return;
    if (playback.offer === packet.sdp && playback.answer) {
      this.answer(packet.id, packet.stream, playback.answer);
      return;
    }
    playback.negotiating = true;
    playback.id = packet.id;
    try {
      if (!playback.peer) {
        const peer = new RTCPeerConnection(this.configuration);
        playback.peer = peer;
        const current = playback;
        peer.ondatachannel = (event) => {
          const channel = event.channel;
          if (
            channel.label !== CANVAS_CHANNEL ||
            current.closed ||
            current.channel
          ) {
            channel.close();
            return;
          }
          current.channel = channel;
          channel.binaryType = 'arraybuffer';
          const frames = new CanvasFrames();
          channel.onmessage = (message) => {
            if (current.closed || !(message.data instanceof ArrayBuffer))
              return;
            const frame = frames.receive(message.data);
            if (!frame) return;
            current.canvasBytes = frame.bytes;
            // A busy viewer paints only the newest complete image on its next
            // animation frame; decoding old images cannot build a UI backlog.
            if (current.canvasAnimation !== undefined) return;
            current.canvasAnimation = requestAnimationFrame(() => {
              current.canvasAnimation = undefined;
              const bytes = current.canvasBytes;
              current.canvasBytes = undefined;
              if (!bytes || current.closed) return;
              // Source data supplies bounded WebP bytes, never markup or URLs.
              if (
                String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
                String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP'
              )
                return;
              let binary = '';
              for (let offset = 0; offset < bytes.length; offset += 8192)
                binary += String.fromCharCode(
                  ...bytes.subarray(offset, offset + 8192),
                );
              current.canvasImage = `data:image/webp;base64,${btoa(binary)}`;
              current.canvasSize = undefined;
              this.update();
            });
          };
        };
        peer.ontrack = (event) => {
          if (current.closed) return;
          current.stream = event.streams[0] ?? new MediaStream([event.track]);
          this.update();
        };
        peer.onconnectionstatechange = () => {
          if (current.closed) return;
          if (peer.connectionState === 'failed') current.failed = true;
          else if (peer.connectionState === 'connected')
            current.failed = undefined;
          const state = this.states.get(current.id);
          if (state) this.renderControls();
        };
      }
      const peer = playback.peer;
      await peer.setRemoteDescription({ type: 'offer', sdp: packet.sdp });
      if (playback.closed) return;
      await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== 'complete')
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timeout);
            peer.removeEventListener('icegatheringstatechange', changed);
            resolve();
          };
          const changed = () => {
            if (peer.iceGatheringState === 'complete' || playback!.closed)
              finish();
          };
          const timeout = setTimeout(finish, 3000);
          peer.addEventListener('icegatheringstatechange', changed);
          changed();
        });
      if (playback.closed) return;
      playback.offer = packet.sdp;
      playback.answer = peer.localDescription!.sdp;
      this.answer(playback.id, packet.stream, playback.answer);
    } catch {
      if (!playback.closed) {
        playback.failed = true;
        const state = this.states.get(playback.id);
        if (state) this.renderControls();
      }
    } finally {
      playback.negotiating = false;
    }
  }
  private volume(playback: Playback) {
    const element = playback.element;
    if (!element) return;
    const state = this.states.get(playback.id);
    element.muted =
      !this.audible || this.soundBlocked || (state?.muted ?? true);
    element.volume = state?.volume ?? 1;
    if (state?.paused && element.readyState >= 2) {
      element.pause();
      return;
    }
    // A newly bound stream needs its first frame even when the source is
    // paused. Afterwards the source state owns the receiver's play/pause state.
    void element
      .play()
      .then(() => {
        if (
          !playback.closed &&
          playback.element === element &&
          this.states.get(playback.id)?.paused
        )
          element.pause();
      })
      .catch((error) => {
        if (error.name === 'NotAllowedError' && !element.muted) {
          if (playback.closed || playback.element !== element) return;
          this.soundBlocked = true;
          for (const active of this.playback.values()) this.volume(active);
          this.renderControls();
        }
      });
  }
  private update() {
    for (const playback of this.playback.values()) {
      const projected = this.node(playback.id) as Element | null;
      if (
        projected?.isConnected &&
        projected.tagName === 'IMG' &&
        projected.hasAttribute(CANVAS_ATTRIBUTE)
      ) {
        const image = projected as HTMLImageElement;
        playback.canvas = image;
        const size = image.getAttribute(CANVAS_ATTRIBUTE)!;
        if (
          playback.canvasImage &&
          size !== playback.canvasSize &&
          /^\d+,\d+$/.test(size)
        ) {
          const [width, height] = size.split(',').map(Number);
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="100%" height="100%" preserveAspectRatio="none" href="${playback.canvasImage}"/></svg>`;
          const previous = playback.canvasURL;
          playback.canvasURL = URL.createObjectURL(
            new Blob([svg], { type: 'image/svg+xml' }),
          );
          playback.canvasSize = size;
          if (previous) URL.revokeObjectURL(previous);
        }
        if (playback.canvasURL && image.src !== playback.canvasURL)
          image.src = playback.canvasURL;
        continue;
      }
      const node = projected as HTMLMediaElement | null;
      if (!node?.isConnected || !['VIDEO', 'AUDIO'].includes(node.tagName))
        continue;
      if (node === playback.element || !playback.stream) continue;
      if (playback.element) {
        playback.element.pause();
        playback.element.srcObject = null;
      }
      playback.element = node;
      node.controls = false;
      node.autoplay = true;
      node.muted = true;
      node.setAttribute('playsinline', '');
      node.srcObject = playback.stream;
      this.volume(playback);
    }
    for (const state of this.states.values()) {
      const image = this.node(state.id) as HTMLImageElement | null;
      if (image?.tagName !== 'IMG' || !image.hasAttribute(CANVAS_ATTRIBUTE))
        continue;
      const failed =
        state.status === 'unavailable' ||
        this.playback.get(state.stream)?.failed;
      if (failed) {
        image.setAttribute(
          'data-floebrowser-unsupported',
          'Canvas unavailable',
        );
        const [width, height] = image
          .getAttribute(CANVAS_ATTRIBUTE)!
          .split(',')
          .map(Number);
        const src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 300 150"><rect width="300" height="150" fill="#f3f5f8"/><text x="150" y="80" text-anchor="middle" fill="#64748b" font-family="system-ui,sans-serif" font-size="12">Canvas unavailable</text></svg>`)}`;
        if (image.src !== src) image.src = src;
      } else image.removeAttribute('data-floebrowser-unsupported');
    }
    this.renderControls();
  }
  /** A page gesture can unlock client audio; it never starts source playback. */
  interact(event: Event) {
    this.dismiss();
    if (!event.isTrusted || !this.soundBlocked || !this.audible) return;
    this.soundBlocked = false;
    for (const playback of this.playback.values()) this.volume(playback);
    this.renderControls();
  }
  private dismiss() {
    if (this.panel.matches(':popover-open')) this.panel.hidePopover();
  }
  private relevant(state: MediaState) {
    const node = this.node(state.id) as HTMLMediaElement | null;
    if (!node?.isConnected || node.hasAttribute(CANVAS_ATTRIBUTE)) return false;
    // Background audio remains controllable even without a rendered element.
    if (!state.paused && !state.muted && state.volume > 0) return true;
    for (
      let element: Element | null = node;
      element;
      element = element.ownerDocument.defaultView?.frameElement ?? null
    ) {
      if (
        !element.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      )
        return false;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
    }
    return true;
  }
  private renderControls() {
    const relevant = new Set<number>();
    for (const state of this.states.values()) {
      if (!this.relevant(state)) continue;
      relevant.add(state.id);
      this.render(state);
    }
    for (const [id, row] of this.rows) row.root.hidden = !relevant.has(id);
    this.controls.hidden = !relevant.size;
    if (!relevant.size) this.dismiss();
    this.toggle.title = this.soundBlocked
      ? 'Sound is muted — media controls'
      : 'Media controls';
    this.sound.textContent =
      this.audible && !this.soundBlocked ? 'Mute audio' : 'Unmute audio';
    this.sound.setAttribute(
      'aria-pressed',
      String(!this.audible || this.soundBlocked),
    );
  }
  private render(state: MediaState) {
    let row = this.rows.get(state.id);
    if (!row) {
      const root = document.createElement('div');
      root.className = 'floe-media-row';
      const label = document.createElement('span');
      label.setAttribute('role', 'status');
      const play = document.createElement('button');
      play.type = 'button';
      play.onclick = () => {
        const current = this.states.get(state.id);
        if (current)
          void this.dispatch({
            kind: 'media',
            node: state.id,
            operation: current.paused ? 'play' : 'pause',
          });
      };
      const seek = document.createElement('input');
      seek.type = 'range';
      seek.min = '0';
      seek.step = '0.1';
      seek.setAttribute('aria-label', 'Seek source media');
      seek.onchange = () => {
        void this.dispatch({
          kind: 'media',
          node: state.id,
          operation: 'seek',
          time: Number(seek.value),
        });
      };
      root.append(label, play, seek);
      this.list.append(root);
      row = { root, label, play, seek };
      this.rows.set(state.id, row);
    }
    row.root.hidden = false;
    const failure = this.playback.get(state.stream)?.failed;
    row.label.textContent =
      state.status === 'unavailable'
        ? 'This media cannot play in this browser.'
        : failure
          ? 'Playback interrupted. Check your connection.'
          : state.reason
            ? 'Playback could not start. Try the page’s play button.'
            : state.paused
              ? 'Paused'
              : state.status === 'streaming'
                ? 'Playing'
                : 'Loading…';
    row.play.disabled = state.status === 'unavailable';
    row.play.textContent = state.paused ? 'Play' : 'Pause';
    row.play.setAttribute(
      'aria-label',
      state.paused ? 'Play source media' : 'Pause source media',
    );
    row.seek.hidden = state.duration <= 0 || state.status === 'unavailable';
    row.seek.max = String(state.duration);
    if (document.activeElement !== row.seek)
      row.seek.value = String(state.time);
  }
  private release(token: string) {
    const playback = this.playback.get(token);
    this.playback.delete(token);
    if (!playback) return;
    playback.closed = true;
    if (playback.canvasAnimation !== undefined)
      cancelAnimationFrame(playback.canvasAnimation);
    playback.canvasBytes = undefined;
    playback.peer?.close();
    playback.channel?.close();
    if (playback.canvasURL) URL.revokeObjectURL(playback.canvasURL);
    if (playback.canvas && playback.canvas.src === playback.canvasURL)
      playback.canvas.removeAttribute('src');
    playback.stream?.getTracks().forEach((track) => track.stop());
    if (playback.element) {
      playback.element.pause();
      playback.element.srcObject = null;
    }
  }
  private remove(id: number) {
    for (const [token, playback] of this.playback)
      if (playback.id === id) this.release(token);
    this.states.delete(id);
    this.rows.get(id)?.root.remove();
    this.rows.delete(id);
    this.renderControls();
  }
  reset() {
    for (const token of this.playback.keys()) this.release(token);
    this.states.clear();
    this.rows.clear();
    this.list.replaceChildren();
    this.dismiss();
    this.controls.hidden = true;
  }
  destroy() {
    this.reset();
    clearInterval(this.timer);
    this.controls.remove();
  }
}
