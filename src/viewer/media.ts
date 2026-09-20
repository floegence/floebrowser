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
  offer?: string;
  answer?: string;
  negotiating: boolean;
  failed?: string;
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
  private dock = document.createElement('details');
  private summary = document.createElement('summary');
  private sound = document.createElement('button');
  private list = document.createElement('div');
  private audible = false;
  private configuration: MediaConfiguration = {};
  private timer: ReturnType<typeof setInterval>;
  constructor(
    container: HTMLElement,
    private node: (id: number) => Node | null | undefined,
    private dispatch: (action: Action) => Promise<boolean>,
    private answer: (node: number, stream: string, sdp: string) => void,
  ) {
    this.dock.className = 'floe-media-dock';
    this.dock.hidden = true;
    this.summary.textContent = 'Media';
    this.sound.type = 'button';
    this.sound.textContent = 'Enable sound';
    this.sound.setAttribute('aria-pressed', 'false');
    this.sound.onclick = () => {
      this.audible = !this.audible;
      this.sound.textContent = this.audible ? 'Mute playback' : 'Enable sound';
      this.sound.setAttribute('aria-pressed', String(this.audible));
      for (const playback of this.playback.values()) this.volume(playback);
    };
    this.dock.append(this.summary, this.sound, this.list);
    container.append(this.dock);
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
      this.render(packet);
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
        peer.ontrack = (event) => {
          if (current.closed) return;
          current.stream = event.streams[0] ?? new MediaStream([event.track]);
          this.update();
        };
        peer.onconnectionstatechange = () => {
          if (current.closed) return;
          if (peer.connectionState === 'failed')
            current.failed = 'Media connection interrupted. Reconnecting…';
          else if (peer.connectionState === 'connected')
            current.failed = undefined;
          const state = this.states.get(current.id);
          if (state) this.render(state);
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
        playback.failed =
          'The client could not establish the media connection.';
        const state = this.states.get(playback.id);
        if (state) this.render(state);
      }
    } finally {
      playback.negotiating = false;
    }
  }
  private volume(playback: Playback) {
    const element = playback.element;
    if (!element) return;
    const state = this.states.get(playback.id);
    element.muted = !this.audible || (state?.muted ?? true);
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
          this.audible = false;
          this.sound.textContent = 'Enable sound';
          this.sound.setAttribute('aria-pressed', 'false');
          for (const active of this.playback.values())
            if (active.element) active.element.muted = true;
        }
      });
  }
  private update() {
    for (const playback of this.playback.values()) {
      const node = this.node(playback.id) as HTMLMediaElement | null;
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
    if (
      state.status === 'unavailable' ||
      this.playback.get(state.stream)?.failed
    )
      this.dock.open = true;
    row.label.textContent =
      state.reason ||
      this.playback.get(state.stream)?.failed ||
      (state.paused
        ? 'Paused at source'
        : state.status === 'streaming'
          ? 'Playing from source'
          : state.status === 'connecting'
            ? 'Connecting media…'
            : 'Waiting for source media');
    row.play.textContent = state.paused ? 'Play' : 'Pause';
    row.play.setAttribute(
      'aria-label',
      state.paused ? 'Play source media' : 'Pause source media',
    );
    row.seek.hidden = state.duration <= 0;
    row.seek.max = String(state.duration);
    if (document.activeElement !== row.seek)
      row.seek.value = String(state.time);
    this.dock.hidden = false;
    this.summary.textContent = `Media · ${this.states.size}`;
  }
  private release(token: string) {
    const playback = this.playback.get(token);
    this.playback.delete(token);
    if (!playback) return;
    playback.closed = true;
    playback.peer?.close();
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
    this.dock.hidden = !this.states.size;
    this.summary.textContent = `Media · ${this.states.size}`;
  }
  reset() {
    for (const token of this.playback.keys()) this.release(token);
    this.states.clear();
    this.rows.clear();
    this.list.replaceChildren();
    this.dock.hidden = true;
  }
  destroy() {
    this.reset();
    clearInterval(this.timer);
    this.dock.remove();
  }
}
