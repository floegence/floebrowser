import type { Action, MediaPacket, MediaState } from '../shared/protocol.js';

type Playback = {
  stream: string;
  next: number;
  mime: string;
  queue: Uint8Array<ArrayBuffer>[];
  bytes: number;
  element?: HTMLMediaElement;
  source?: MediaSource;
  buffer?: SourceBuffer;
  dispose?: () => void;
  failed?: string;
};

/** Trusted parent code decodes source media in the scriptless replay document. */
export class MediaView {
  private states = new Map<number, MediaState>();
  private playback = new Map<number, Playback>();
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
  private timer: ReturnType<typeof setInterval>;

  constructor(
    container: HTMLElement,
    private node: (id: number) => Node | null | undefined,
    private dispatch: (action: Action) => Promise<boolean>,
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
      for (const [id, playback] of this.playback) this.volume(id, playback);
    };
    this.dock.append(this.summary, this.sound, this.list);
    container.append(this.dock);
    this.timer = setInterval(() => this.update(), 100);
  }
  receive(packet: MediaPacket) {
    if (packet.kind === 'removed') {
      this.remove(packet.id);
      return;
    }
    if (packet.kind === 'state') {
      if (!this.states.has(packet.id) && this.states.size >= 8) return;
      this.states.set(packet.id, packet);
      this.render(packet);
      const playback = this.playback.get(packet.id);
      if (playback) this.volume(packet.id, playback);
      return;
    }
    let playback = this.playback.get(packet.id);
    if (!playback || playback.stream !== packet.stream) {
      if (packet.sequence !== 0) return;
      this.release(packet.id);
      playback = {
        stream: packet.stream,
        next: 0,
        mime: packet.mime,
        queue: [],
        bytes: 0,
      };
      if (this.playback.size >= 8) return;
      this.playback.set(packet.id, playback);
    }
    if (playback.failed) return;
    if (packet.sequence !== playback.next++) {
      this.fail(packet.id, 'Media interrupted. Reconnect for a fresh stream.');
      return;
    }
    try {
      const binary = atob(packet.data);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      if ((playback.bytes += bytes.byteLength) > 2 * 1024 * 1024) {
        this.fail(packet.id, 'Media is behind. Reconnect for a fresh stream.');
        return;
      }
      playback.queue.push(bytes);
      this.update();
    } catch {
      this.fail(packet.id, 'The media stream could not be decoded.');
    }
  }
  private volume(id: number, playback: Playback) {
    const element = playback.element;
    if (!element) return;
    const state = this.states.get(id);
    element.muted = !this.audible || (state?.muted ?? true);
    element.volume = state?.volume ?? 1;
    void element.play().catch(() => {
      if (!element.muted) {
        element.muted = true;
        this.sound.textContent = 'Enable sound';
        this.sound.setAttribute('aria-pressed', 'false');
        this.audible = false;
        for (const active of this.playback.values())
          if (active.element) active.element.muted = true;
      }
    });
  }
  private update() {
    for (const [id, playback] of this.playback) {
      if (playback.failed) continue;
      const node = this.node(id) as HTMLMediaElement | null;
      if (!node?.isConnected || !['VIDEO', 'AUDIO'].includes(node.tagName)) {
        if (playback.element) this.remove(id);
        continue;
      }
      if (playback.element && playback.element !== node) {
        this.fail(id, 'Media document changed. Reconnect to resume.');
        continue;
      }
      if (!playback.element) {
        if (
          typeof MediaSource === 'undefined' ||
          !MediaSource.isTypeSupported(playback.mime)
        ) {
          this.fail(id, 'This client cannot decode the source media format.');
          continue;
        }
        const source = new MediaSource();
        const url = URL.createObjectURL(source);
        playback.element = node;
        playback.source = source;
        const opened = () => {
          try {
            playback.buffer = source.addSourceBuffer(playback.mime);
            playback.buffer.addEventListener('updateend', append);
            playback.buffer.addEventListener('error', error);
            append();
          } catch {
            error();
          }
        };
        const append = () => this.append(id, playback);
        const error = () =>
          this.fail(id, 'The media stream could not be decoded.');
        source.addEventListener('sourceopen', opened);
        node.addEventListener('error', error);
        playback.dispose = () => {
          source.removeEventListener('sourceopen', opened);
          node.removeEventListener('error', error);
          playback.buffer?.removeEventListener('updateend', append);
          playback.buffer?.removeEventListener('error', error);
          node.pause();
          node.removeAttribute('src');
          node.load();
          URL.revokeObjectURL(url);
        };
        node.controls = false;
        node.muted = true;
        node.autoplay = true;
        node.setAttribute('playsinline', '');
        node.src = url;
        this.volume(id, playback);
      }
      this.append(id, playback);
    }
  }
  private append(id: number, playback: Playback) {
    const buffer = playback.buffer,
      element = playback.element;
    if (
      !buffer ||
      !element ||
      buffer.updating ||
      playback.failed ||
      playback.source?.readyState !== 'open'
    )
      return;
    try {
      if (buffer.buffered.length) {
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        if (end - element.currentTime > 1.5)
          element.currentTime = Math.max(buffer.buffered.start(0), end - 0.35);
        if (
          element.currentTime > 20 &&
          buffer.buffered.start(0) < element.currentTime - 15
        ) {
          buffer.remove(0, element.currentTime - 10);
          return;
        }
      }
      const next = playback.queue.shift();
      if (next) {
        playback.bytes -= next.byteLength;
        buffer.appendBuffer(next);
      }
    } catch {
      this.fail(
        id,
        'The media buffer could not be updated. Reconnect to resume.',
      );
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
    if (state.status === 'unavailable') this.dock.open = true;
    row.label.textContent =
      this.playback.get(state.id)?.failed ||
      state.reason ||
      (state.paused
        ? 'Paused at source'
        : state.status === 'streaming'
          ? 'Playing from source'
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
  private fail(id: number, reason: string) {
    const playback = this.playback.get(id);
    if (!playback || playback.failed) return;
    playback.failed = reason;
    playback.dispose?.();
    playback.dispose = undefined;
    playback.queue = [];
    playback.bytes = 0;
    const state = this.states.get(id);
    if (state) this.render(state);
    this.dock.open = true;
  }
  private release(id: number) {
    const playback = this.playback.get(id);
    this.playback.delete(id);
    playback?.dispose?.();
  }
  private remove(id: number) {
    this.release(id);
    this.states.delete(id);
    this.rows.get(id)?.root.remove();
    this.rows.delete(id);
    this.dock.hidden = !this.states.size;
    this.summary.textContent = `Media · ${this.states.size}`;
  }
  reset() {
    for (const id of this.playback.keys()) this.release(id);
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
