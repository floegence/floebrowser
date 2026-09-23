import { CANVAS_ATTRIBUTE } from '../shared/style.js';
import { ElementDecoder, type DecoderEvent } from './media-decoder.js';
import { AudioOutput } from './audio-output.js';
import type { MediaFrame } from '../shared/media-wire.js';
import { setIcon } from './icons.js';
import { browserText, type BrowserText } from './messages.js';
import type { Action, MediaPacket, MediaState } from '../shared/protocol.js';

type ScopedState = MediaState & { target: string; view: string };
const identity = (target: string, stream: string) => `${target}:${stream}`;

type Playback = {
  id: number;
  token: string;
  target: string;
  view: string;
  decoder?: ElementDecoder;
  paint?: HTMLCanvasElement;
  stream?: MediaStream;
  element?: HTMLMediaElement;
  canvasURL?: string;
  canvasImage?: string;
  canvasSize?: string;
  canvasBytes?: Uint8Array;
  canvasAnimation?: number;
  canvas?: HTMLImageElement;
  failed?: boolean;
  closed: boolean;
  clock?: { timestamp: number; at: number };
  frames: { frame: VideoFrame; presentAt: number }[];
  frameAnimation?: number;
};

export type MediaAssets = {
  decoderURL: string | URL;
  audioWorkletURL: string | URL;
};

/** Decodes host-carried element media. Website code and media URLs never execute
 * here, and the client never establishes a WebRTC connection. */
export class MediaView {
  private states = new Map<string, ScopedState>();
  private playback = new Map<string, Playback>();
  private rows = new Map<
    string,
    {
      root: HTMLElement;
      label: HTMLElement;
      title: HTMLElement;
      play: HTMLButtonElement;
      mute: HTMLButtonElement;
      seek: HTMLInputElement;
      timeline: HTMLElement;
      elapsed: HTMLElement;
      duration: HTMLElement;
      locate: HTMLButtonElement;
      location: HTMLElement;
    }
  >();
  private controls = document.createElement('div');
  private toggle = document.createElement('button');
  private panel = document.createElement('div');
  private sound = document.createElement('button');
  private list = document.createElement('div');
  private audible = true;
  private soundBlocked = false;
  private highlight?: Animation;
  private audio: AudioOutput;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    container: HTMLElement | undefined,
    private node: (id: number, target?: string) => Node | null | undefined,
    private dispatch: (
      action: Action,
      target?: string,
      stream?: string,
    ) => Promise<boolean>,
    private keyframe: (view: string, stream: string, target?: string) => void,
    private assets: MediaAssets = {
      decoderURL: new URL('media-worker.js', document.baseURI),
      audioWorkletURL: new URL('audio-worklet.js', document.baseURI),
    },
    private targetTitle: (target: string) => string = () => '',
    private text: BrowserText = browserText(),
  ) {
    this.audio = new AudioOutput(assets.audioWorkletURL, (blocked) => {
      this.soundBlocked = blocked;
      this.renderControls();
    });
    this.controls.className = 'floe-media-controls';
    this.controls.hidden = true;
    this.toggle.type = 'button';
    this.toggle.className = 'floe-media-toggle';
    this.toggle.setAttribute('aria-label', this.text('media.controls'));
    this.toggle.setAttribute('aria-haspopup', 'dialog');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.innerHTML =
      '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h9M3 9h6M3 13h5M12 7l5 3-5 3V7Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    this.panel.className = 'floe-media-panel';
    this.panel.popover = 'auto';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', this.text('media.controls'));
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
    this.sound.className = 'floe-media-sound';
    this.sound.onclick = () => {
      this.audible = this.soundBlocked || !this.audible;
      this.soundBlocked = false;
      if (this.audible) void this.audio.unlock();
      for (const playback of this.playback.values()) this.volume(playback);
      this.renderControls();
    };
    const header = document.createElement('header');
    header.className = 'floe-media-header';
    const heading = document.createElement('h2');
    heading.textContent = this.text('media.title');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'floe-media-dismiss';
    close.title = this.text('media.close');
    close.setAttribute('aria-label', close.title);
    setIcon(close, 'close');
    close.onclick = () => {
      this.dismiss();
      this.toggle.focus();
    };
    header.append(heading, this.sound, close);
    this.list.className = 'floe-media-list';
    this.panel.append(header, this.list);
    this.controls.append(this.toggle, this.panel);
    container?.append(this.controls);
    this.timer = setInterval(() => this.update(), 100);
  }
  receive(packet: MediaPacket, scope: { target: string; view: string }) {
    if (packet.kind === 'removed') {
      for (const [key, state] of this.states)
        if (state.target === scope.target && state.id === packet.id)
          this.remove(key);
      return;
    }
    for (const [key, playback] of this.playback)
      if (
        playback.target === scope.target &&
        playback.id === packet.id &&
        playback.token !== packet.stream
      )
        this.remove(key, false);
    const key = identity(scope.target, packet.stream);
    let playback = this.playback.get(key);
    if (playback && playback.view !== scope.view) {
      this.remove(key, false);
      playback = undefined;
    }
    if (!playback) {
      if (
        this.playback.size >= 128 ||
        [...this.playback.values()].filter(
          (item) => item.target === scope.target,
        ).length >= 8
      )
        return;
      playback = {
        id: packet.id,
        token: packet.stream,
        ...scope,
        closed: false,
        frames: [],
      };
      this.playback.set(key, playback);
      this.keyframe(scope.view, packet.stream, scope.target);
    }
    playback.id = packet.id;
    this.states.set(key, { ...packet, ...scope });
    this.renderControls();
    this.volume(playback);
  }
  nodeID(target: string, stream: string): number | undefined {
    return this.states.get(identity(target, stream))?.id;
  }
  select(target: string): void {
    for (const playback of this.playback.values()) {
      if (playback.target !== target) continue;
      this.clearPictures(playback);
      playback.decoder?.resetVideo();
      this.keyframe(playback.view, playback.token, playback.target);
    }
    this.update();
  }
  frame(frame: MediaFrame): void {
    const h = frame.header;
    const playback = this.playback.get(identity(h.target, h.stream));
    if (
      !playback ||
      playback.closed ||
      playback.target !== h.target ||
      playback.view !== h.view ||
      playback.id !== h.node ||
      this.states.get(identity(h.target, h.stream))?.stream !== h.stream
    )
      return;
    if (h.track === 'canvas') {
      playback.canvasBytes = frame.data;
      if (playback.canvasAnimation !== undefined) return;
      playback.canvasAnimation = requestAnimationFrame(() => {
        playback.canvasAnimation = undefined;
        const bytes = playback.canvasBytes;
        playback.canvasBytes = undefined;
        if (
          !bytes ||
          playback.closed ||
          String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
          String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP'
        )
          return;
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const image = `data:image/webp;base64,${btoa(binary)}`;
        // Sources can repaint or retransmit identical pixels. Keep their decoded
        // resource instead of allocating another SVG document for every packet.
        if (playback.canvasImage !== image) {
          playback.canvasImage = image;
          playback.canvasSize = undefined;
        }
        this.update();
      });
      return;
    }
    playback.decoder ??= new ElementDecoder(this.assets.decoderURL, (event) =>
      this.decoded(playback, event),
    );
    playback.decoder.push(frame);
  }
  private delay(playback: Playback, timestamp: number): number {
    const now = performance.now();
    let clock = playback.clock;
    if (
      !clock ||
      now - (clock.at + (timestamp - clock.timestamp) / 1000) > 250 ||
      clock.at + (timestamp - clock.timestamp) / 1000 - now > 500
    )
      playback.clock = clock = { timestamp, at: now + 50 };
    return clock.at + (timestamp - clock.timestamp) / 1000 - now;
  }
  private decoded(playback: Playback, event: DecoderEvent): void {
    if (playback.closed) {
      if (event.type === 'video') event.frame.close();
      return;
    }
    if (event.type === 'keyframe')
      this.keyframe(playback.view, playback.token, playback.target);
    else if (event.type === 'unavailable') {
      playback.failed = true;
      this.renderControls();
    } else if (event.type === 'audio') {
      const count = event.channels[0]?.length ?? 0;
      // Creating the audio device can block. Anchor the shared media clock at
      // packet delivery, before that startup cost shifts every video deadline.
      const delay = this.delay(playback, event.timestamp);
      void this.audio
        .add(identity(playback.target, playback.token), (frames) =>
          playback.decoder?.audioConsumed(frames),
        )
        .then(() => this.volume(playback))
        .catch(() => {
          playback.failed = true;
        });
      if (
        !this.audio.push(
          identity(playback.target, playback.token),
          event.channels,
          delay,
        )
      )
        playback.decoder?.audioConsumed(count);
    } else if (event.type === 'video') {
      // Commit this picture's deadline once. A concurrent audio clock
      // correction must not reschedule it on every animation frame forever.
      const presentAt =
        performance.now() +
        Math.max(0, this.delay(playback, event.frame.timestamp));
      playback.frames.push({ frame: event.frame, presentAt });
      if (playback.frameAnimation !== undefined) return;
      const paint = () => {
        playback.frameAnimation = undefined;
        if (playback.closed) return;
        const now = performance.now();
        let frame: VideoFrame | undefined;
        // Preserve future pictures. Once behind, consume all due pictures and
        // draw only the newest, returning every credit without chasing history.
        playback.frames = playback.frames.filter((pending) => {
          if (pending.presentAt - now > 5) return true;
          if (frame) {
            frame.close();
            playback.decoder?.painted();
          }
          frame = pending.frame;
          return false;
        });
        if (playback.frames.length)
          playback.frameAnimation = requestAnimationFrame(paint);
        if (!frame) return;
        playback.paint ??= document.createElement('canvas');
        const canvas = playback.paint;
        if (canvas.width !== frame.displayWidth)
          canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight)
          canvas.height = frame.displayHeight;
        canvas.getContext('2d')!.drawImage(frame, 0, 0);
        frame.close();
        // Automatic capture of changed pictures works across viewer engines;
        // requestFrame() is absent in Firefox and some WebKit releases.
        playback.stream ??= canvas.captureStream(24);
        const track = playback.stream.getVideoTracks()[0] as
          CanvasCaptureMediaStreamTrack | undefined;
        track?.requestFrame?.();
        playback.decoder?.painted();
        this.update();
      };
      paint();
    }
  }
  private clearPictures(playback: Playback): void {
    if (playback.frameAnimation !== undefined)
      cancelAnimationFrame(playback.frameAnimation);
    playback.frameAnimation = undefined;
    for (const { frame } of playback.frames) {
      frame.close();
      playback.decoder?.painted();
    }
    playback.frames = [];
  }
  private volume(playback: Playback) {
    const state = this.states.get(identity(playback.target, playback.token));
    const muted =
      !this.audible || (state?.muted ?? true) || (state?.paused ?? true);
    this.audio.volume(
      identity(playback.target, playback.token),
      muted ? 0 : (state?.volume ?? 1),
    );
    // This stream contains decoded video only. Keep its clock running so a
    // paused source's first frame and later seeks can both be displayed.
    if (playback.element && playback.stream) {
      playback.element.muted = true;
      void playback.element.play().catch(() => {});
    }
  }
  private update() {
    for (const playback of this.playback.values()) {
      const projected = this.node(
        playback.id,
        playback.target,
      ) as Element | null;
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
      if (
        node === playback.element ||
        (node.tagName === 'VIDEO' && !playback.stream)
      )
        continue;
      if (playback.element) {
        playback.element.pause();
        playback.element.srcObject = null;
      }
      playback.element = node;
      node.controls = false;
      node.autoplay = true;
      node.muted = true;
      node.setAttribute('playsinline', '');
      if (playback.stream) node.srcObject = playback.stream;
      this.volume(playback);
    }
    for (const state of this.states.values()) {
      const image = this.node(
        state.id,
        state.target,
      ) as HTMLImageElement | null;
      if (image?.tagName !== 'IMG' || !image.hasAttribute(CANVAS_ATTRIBUTE))
        continue;
      const failed =
        state.status === 'unavailable' ||
        this.playback.get(identity(state.target, state.stream))?.failed;
      if (failed) {
        image.setAttribute(
          'data-floebrowser-unsupported',
          this.text('media.canvasUnavailable'),
        );
        const [width, height] = image
          .getAttribute(CANVAS_ATTRIBUTE)!
          .split(',')
          .map(Number);
        const src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 300 150"><rect width="300" height="150" fill="#f3f5f8"/><text x="150" y="80" text-anchor="middle" fill="#64748b" font-family="system-ui,sans-serif" font-size="12">${this.text('media.canvasUnavailable').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</text></svg>`)}`;
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
    void this.audio.unlock();
    for (const playback of this.playback.values()) this.volume(playback);
    this.renderControls();
  }
  private dismiss() {
    if (this.panel.matches(':popover-open')) this.panel.hidePopover();
  }
  private relevant(state: ScopedState) {
    const node = this.node(state.id, state.target) as HTMLMediaElement | null;
    if (!node?.isConnected)
      return !state.paused && (state.volume > 0 || state.duration > 0);
    if (node.hasAttribute(CANVAS_ATTRIBUTE)) return false;
    // Background audio remains controllable even without a rendered element.
    if (!state.paused && !state.muted && state.volume > 0) return true;
    return this.visible(node);
  }
  private visible(node: Element) {
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
    const relevant = new Set<string>();
    for (const state of this.states.values()) {
      if (!this.relevant(state)) continue;
      relevant.add(identity(state.target, state.stream));
      this.render(state);
    }
    for (const [id, row] of this.rows) row.root.hidden = !relevant.has(id);
    this.controls.hidden = !relevant.size;
    if (!relevant.size) this.dismiss();
    this.toggle.title = this.soundBlocked
      ? this.text('media.soundBlocked')
      : this.text('media.controls');
    const soundLabel =
      this.audible && !this.soundBlocked
        ? this.text('media.mute')
        : this.text('media.unmute');
    this.sound.title = soundLabel;
    this.sound.setAttribute('aria-label', soundLabel);
    setIcon(this.sound, this.audible && !this.soundBlocked ? 'sound' : 'muted');
    this.sound.setAttribute(
      'aria-pressed',
      String(!this.audible || this.soundBlocked),
    );
  }
  private render(state: ScopedState) {
    let row = this.rows.get(identity(state.target, state.stream));
    if (!row) {
      const root = document.createElement('div');
      root.className = 'floe-media-row';
      const badge = document.createElement('span');
      badge.className = 'floe-media-art';
      setIcon(
        badge,
        this.node(state.id, state.target)?.nodeName === 'AUDIO'
          ? 'audio'
          : 'video',
      );
      const info = document.createElement('div');
      info.className = 'floe-media-info';
      const title = document.createElement('div');
      title.className = 'floe-media-title';
      const label = document.createElement('span');
      label.className = 'floe-media-status';
      label.setAttribute('role', 'status');
      info.append(title, label);
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'floe-media-play';
      play.onclick = () => {
        const current = this.states.get(identity(state.target, state.stream));
        if (current)
          void this.dispatch(
            {
              kind: 'media',
              node:
                this.states.get(identity(state.target, state.stream))?.id ??
                state.id,
              operation: current.paused ? 'play' : 'pause',
            },
            state.target,
            state.stream,
          );
      };
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'floe-media-mute';
      mute.onclick = async () => {
        const current = this.states.get(identity(state.target, state.stream));
        if (!current || mute.disabled) return;
        mute.disabled = true;
        try {
          await this.dispatch(
            {
              kind: 'media',
              node: current.id,
              operation: 'mute',
              muted: !current.muted,
            },
            state.target,
            state.stream,
          );
        } finally {
          mute.disabled = false;
        }
      };
      const actions = document.createElement('div');
      actions.className = 'floe-media-actions';
      actions.append(mute, play);
      const seek = document.createElement('input');
      seek.type = 'range';
      seek.min = '0';
      seek.step = '0.1';
      seek.setAttribute('aria-label', this.text('media.seek'));
      const timeline = document.createElement('div');
      timeline.className = 'floe-media-timeline';
      const times = document.createElement('div');
      times.className = 'floe-media-times';
      const elapsed = document.createElement('span');
      const duration = document.createElement('span');
      times.append(elapsed, duration);
      timeline.append(seek, times);
      seek.oninput = () => this.progress(seek, elapsed, Number(seek.value));
      seek.onchange = () => {
        void this.dispatch(
          {
            kind: 'media',
            node:
              this.states.get(identity(state.target, state.stream))?.id ??
              state.id,
            operation: 'seek',
            time: Number(seek.value),
          },
          state.target,
          state.stream,
        );
      };
      const location = document.createElement('div');
      location.className = 'floe-media-location';
      const locate = document.createElement('button');
      locate.type = 'button';
      locate.className = 'floe-media-locate';
      const icon = document.createElement('span');
      setIcon(icon, 'locate');
      locate.append(
        icon,
        document.createTextNode(this.text('media.showOnPage')),
      );
      locate.onclick = async () => {
        const current = this.states.get(identity(state.target, state.stream));
        if (!current || locate.disabled) return;
        locate.disabled = true;
        try {
          if (!this.node(current.id, state.target)) {
            if (await this.dispatch({ kind: 'tab_select', tab: state.target }))
              this.dismiss();
            return;
          }
          const ok = await this.dispatch(
            {
              kind: 'media',
              node:
                this.states.get(identity(state.target, state.stream))?.id ??
                state.id,
              operation: 'reveal',
            },
            state.target,
            state.stream,
          );
          if (
            !ok ||
            this.states.get(identity(state.target, state.stream))?.stream !==
              current.stream
          )
            return;
          const node = this.node(state.id, state.target) as HTMLElement | null;
          if (!node?.isConnected) return;
          this.dismiss();
          this.toggle.focus({ preventScroll: true });
          this.highlight?.cancel();
          const color = '#557aac';
          const reduced = matchMedia(
            '(prefers-reduced-motion: reduce)',
          ).matches;
          this.highlight = node.animate(
            [
              {
                outline: `3px solid ${color}`,
                outlineOffset: '-3px',
                offset: 0,
              },
              {
                outline: `3px solid ${color}`,
                outlineOffset: '-3px',
                offset: reduced ? 1 : 0.8,
              },
              {
                outline: `3px solid ${reduced ? color : 'transparent'}`,
                outlineOffset: '-3px',
                offset: 1,
              },
            ],
            { duration: 2200 },
          );
          this.highlight.id = 'floe-media-location';
        } finally {
          locate.disabled = false;
        }
      };
      location.append(locate);
      root.append(badge, info, actions, timeline, location);
      this.list.append(root);
      row = {
        root,
        label,
        title,
        play,
        mute,
        seek,
        timeline,
        elapsed,
        duration,
        locate,
        location,
      };
      this.rows.set(identity(state.target, state.stream), row);
    }
    row.root.hidden = false;
    const node = this.node(state.id, state.target) as HTMLElement | null;
    const title =
      node?.getAttribute('aria-label') ||
      node?.title ||
      node?.ownerDocument.title ||
      this.targetTitle(state.target) ||
      (node?.tagName === 'AUDIO'
        ? this.text('media.audio')
        : this.text('media.video'));
    if (row.title.textContent !== title) row.title.textContent = title;
    row.title.title = title;
    const visible = !!node && this.visible(node);
    const canLocate = visible || !node;
    const label = visible
      ? this.text('media.showOnPage')
      : this.text('media.openTab');
    if (row.locate.lastChild?.textContent !== label)
      row.locate.lastChild!.textContent = label;
    if (canLocate && row.locate.parentElement !== row.location)
      row.location.replaceChildren(row.locate);
    else if (
      !canLocate &&
      row.location.textContent !== this.text('media.noPlayer')
    )
      row.location.textContent = this.text('media.noPlayer');
    const failure = this.playback.get(
      identity(state.target, state.stream),
    )?.failed;
    row.label.textContent =
      state.status === 'unavailable'
        ? this.text('media.unavailable')
        : failure
          ? this.text('media.interrupted')
          : state.reason
            ? this.text('media.playFailed')
            : state.paused
              ? this.text('media.paused')
              : state.status === 'streaming'
                ? state.muted ||
                  state.volume === 0 ||
                  !this.audible ||
                  this.soundBlocked
                  ? this.text('media.playingMuted')
                  : this.text('media.playing')
                : this.text('media.loading');
    row.play.disabled = state.status === 'unavailable';
    const muteLabel = this.text(
      state.muted ? 'media.unmuteSource' : 'media.muteSource',
    );
    row.mute.title = muteLabel;
    row.mute.setAttribute('aria-label', muteLabel);
    row.mute.setAttribute('aria-pressed', String(state.muted));
    setIcon(row.mute, state.muted ? 'muted' : 'sound');
    setIcon(row.play, state.paused ? 'play' : 'pause');
    row.play.title = state.paused
      ? this.text('media.play')
      : this.text('media.pause');
    row.play.setAttribute(
      'aria-label',
      state.paused
        ? this.text('media.playSource')
        : this.text('media.pauseSource'),
    );
    row.timeline.hidden = state.duration <= 0 || state.status === 'unavailable';
    row.seek.max = String(state.duration);
    if (document.activeElement !== row.seek)
      row.seek.value = String(state.time);
    this.progress(row.seek, row.elapsed, Number(row.seek.value));
    row.duration.textContent = this.time(state.duration);
  }
  private time(seconds: number) {
    const value = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(value / 60);
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
      : `${minutes}:${String(value % 60).padStart(2, '0')}`;
  }
  private progress(
    seek: HTMLInputElement,
    elapsed: HTMLElement,
    value: number,
  ) {
    const duration = Number(seek.max);
    seek.style.setProperty(
      '--floe-progress',
      `${duration > 0 ? Math.min(100, (value / duration) * 100) : 0}%`,
    );
    elapsed.textContent = this.time(value);
    seek.setAttribute(
      'aria-valuetext',
      this.text('media.progress', {
        elapsed: this.time(value),
        duration: this.time(duration),
      }),
    );
  }
  private release(token: string) {
    const playback = this.playback.get(token);
    this.playback.delete(token);
    if (!playback) return;
    playback.closed = true;
    if (playback.canvasAnimation !== undefined)
      cancelAnimationFrame(playback.canvasAnimation);
    playback.canvasBytes = undefined;
    this.clearPictures(playback);
    playback.decoder?.close();
    this.audio.remove(token);
    if (playback.canvasURL) URL.revokeObjectURL(playback.canvasURL);
    if (playback.canvas && playback.canvas.src === playback.canvasURL)
      playback.canvas.removeAttribute('src');
    playback.stream?.getTracks().forEach((track) => track.stop());
    if (playback.element) {
      playback.element.pause();
      playback.element.srcObject = null;
    }
  }
  private remove(key: string, render = true) {
    this.release(key);
    this.states.delete(key);
    this.rows.get(key)?.root.remove();
    this.rows.delete(key);
    if (render) this.renderControls();
  }
  end(target: string, view: string): void {
    for (const [key, playback] of this.playback)
      if (playback.target === target && playback.view === view)
        this.remove(key);
  }
  reset() {
    this.highlight?.cancel();
    this.highlight = undefined;
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
    this.audio.close();
    this.controls.remove();
  }
}
