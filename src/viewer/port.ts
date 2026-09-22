import {
  clientMessageSchema,
  MAX_COMMAND_BYTES,
  MAX_MESSAGE_BYTES,
  DISCONNECT_CODES,
  type ClientMessage,
  type DisconnectReason,
  type ProjectionConnection,
  type ServerMessage,
} from '../shared/protocol.js';
import {
  mediaFrameHeaderSchema,
  MAX_MEDIA_FRAME_BYTES,
  MAX_MEDIA_HEADER_BYTES,
  type MediaFrame,
} from '../shared/media-wire.js';

export type ProjectionPorts = Readonly<{
  messages: MessagePort;
  media: MessagePort;
}>;
type Budget = { packet: number; bytes: number; count: number };
const commands: Budget = {
  packet: MAX_COMMAND_BYTES,
  bytes: 256 * 1024,
  count: 64,
};
const messages: Budget = {
  packet: MAX_MESSAGE_BYTES,
  bytes: 32 * 1024 * 1024,
  count: 128,
};
const media: Budget = {
  packet: MAX_MEDIA_FRAME_BYTES + MAX_MEDIA_HEADER_BYTES,
  bytes: 8 * 1024 * 1024,
  count: 32,
};
const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const mediaBytes = (value: unknown) => {
  const frame = value as MediaFrame;
  const header = mediaFrameHeaderSchema.parse(frame?.header);
  if (
    !(frame.data instanceof Uint8Array) ||
    frame.data.byteLength !== header.bytes
  )
    throw new Error('Invalid media frame');
  return frame.data.byteLength + jsonBytes(header);
};

/** Credit is returned after the destination consumer finishes, not when its
 * MessagePort event is queued. Each direction has its own hard memory budget. */
class CreditPort {
  private closed = false;
  private next = 0;
  private received = 0;
  private sentBytes = 0;
  private receivedBytes = 0;
  private consuming = false;
  private inbox: Array<{ id: number; value: unknown; bytes: number }> = [];
  private pending = new Map<
    number,
    { bytes: number; resolve(): void; reject(error: Error): void }
  >();
  constructor(
    private port: MessagePort,
    private outgoing: Budget,
    private incoming: Budget,
    private measure: (value: unknown) => number,
    private consume: (value: unknown) => void | Promise<void>,
    private ended: (reason?: DisconnectReason) => void,
  ) {
    port.addEventListener('message', this.receive);
    port.addEventListener('messageerror', this.failed);
    port.start();
  }
  send(value: unknown, transfer: Transferable[] = []): Promise<void> {
    const work = new Promise<void>((resolve, reject) => {
      try {
        if (this.closed) throw new Error('Projection port closed');
        const bytes = this.measure(value);
        if (
          bytes > this.outgoing.packet ||
          this.sentBytes + bytes > this.outgoing.bytes ||
          this.pending.size >= this.outgoing.count
        )
          throw new Error('Projection port budget exceeded');
        const id = ++this.next;
        this.pending.set(id, { bytes, resolve, reject });
        this.sentBytes += bytes;
        this.port.postMessage({ type: 'packet', id, value }, transfer);
      } catch {
        reject(new Error('Projection port unavailable'));
        this.close('source_unavailable');
      }
    });
    // Event-driven carriers may not await subscribers. Their unconsumed queue
    // still fails at the same bound; promise-aware carriers propagate credit.
    void work.catch(() => {});
    return work;
  }
  private failed = () => this.close('source_unavailable');
  private receive = (event: MessageEvent) => {
    if (this.closed) return;
    const message = event.data;
    if (message?.type === 'end') {
      const reason =
        message.reason === undefined ||
        (typeof message.reason === 'string' &&
          Object.hasOwn(DISCONNECT_CODES, message.reason))
          ? (message.reason as DisconnectReason | undefined)
          : 'source_unavailable';
      this.close(reason, false);
      return;
    }
    if (message?.type === 'credit') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.failed();
        return;
      }
      this.pending.delete(message.id);
      this.sentBytes -= pending.bytes;
      pending.resolve();
      return;
    }
    try {
      if (
        message?.type !== 'packet' ||
        !Number.isSafeInteger(message.id) ||
        message.id !== this.received + 1
      )
        throw new Error('Invalid port sequence');
      const bytes = this.measure(message.value);
      if (
        bytes > this.incoming.packet ||
        this.receivedBytes + bytes > this.incoming.bytes ||
        this.inbox.length + Number(this.consuming) >= this.incoming.count
      )
        throw new Error('Projection port budget exceeded');
      this.received = message.id;
      this.receivedBytes += bytes;
      this.inbox.push({ id: message.id, value: message.value, bytes });
      void this.drain();
    } catch {
      this.failed();
    }
  };
  private async drain(): Promise<void> {
    if (this.consuming || this.closed) return;
    this.consuming = true;
    try {
      while (!this.closed && this.inbox.length) {
        const item = this.inbox.shift()!;
        await this.consume(item.value);
        this.receivedBytes -= item.bytes;
        if (!this.closed)
          this.port.postMessage({ type: 'credit', id: item.id });
      }
    } catch {
      this.failed();
    } finally {
      this.consuming = false;
    }
  }
  close(reason?: DisconnectReason, notify = true): void {
    if (this.closed) return;
    this.closed = true;
    if (notify) {
      try {
        this.port.postMessage({ type: 'end', reason });
      } catch {
        /* Peer already closed. */
      }
    }
    this.port.removeEventListener('message', this.receive);
    this.port.removeEventListener('messageerror', this.failed);
    this.port.close();
    this.inbox = [];
    for (const pending of this.pending.values())
      pending.reject(new Error('Projection port closed'));
    this.pending.clear();
    this.ended(reason);
  }
}

/** The host transfers only these dedicated ports after validating the destination
 * window. No URL, authentication, transport acquisition or generic host API is
 * exposed. File pickers and download destinations remain explicit host options. */
export function projectionPortConnection(
  ports: ProjectionPorts,
  files: Pick<ProjectionConnection, 'upload' | 'download'> = {},
): ProjectionConnection {
  const receivers = new Set<(message: ServerMessage) => void | Promise<void>>();
  const frames = new Set<(frame: MediaFrame) => void | Promise<void>>();
  const disconnected = new Set<(reason?: DisconnectReason) => void>();
  let closed = false;
  let reason: DisconnectReason | undefined;
  const end = (failure?: DisconnectReason) => {
    if (closed) return;
    closed = true;
    reason = failure;
    data.close(failure);
    pictures.close(failure);
    for (const listener of disconnected) listener(failure);
    receivers.clear();
    frames.clear();
    disconnected.clear();
  };
  const data = new CreditPort(
    ports.messages,
    commands,
    messages,
    jsonBytes,
    async (value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as ServerMessage).type !== 'string'
      )
        throw new Error('Invalid projection message');
      for (const listener of receivers) await listener(value as ServerMessage);
    },
    end,
  );
  const pictures = new CreditPort(
    ports.media,
    media,
    media,
    mediaBytes,
    async (value) => {
      for (const listener of frames) await listener(value as MediaFrame);
    },
    () => {
      frames.clear();
    },
  );
  ports.messages.postMessage({ type: 'ready' });
  return {
    ...files,
    send: (message) => {
      if (!closed) void data.send(message);
    },
    subscribe: (listener) => {
      if (!closed) receivers.add(listener);
      return () => receivers.delete(listener);
    },
    subscribeMedia: (listener) => {
      if (!closed) frames.add(listener);
      return () => frames.delete(listener);
    },
    onDisconnect: (listener) => {
      if (closed) listener(reason);
      else disconnected.add(listener);
      return () => disconnected.delete(listener);
    },
    close: () => end(),
  };
}

/** Starts a host-owned carrier only after the destination document is listening.
 * Carriers that await subscription callbacks receive DOM/media backpressure;
 * non-awaiting event carriers terminate at the same hard queue limits. */
export function serveProjectionPorts(
  ports: ProjectionPorts,
  connect: () => ProjectionConnection,
): { close(): void } {
  let connection: ProjectionConnection | undefined;
  let data: CreditPort | undefined, pictures: CreditPort | undefined;
  let closed = false;
  const disposers: Array<() => void> = [];
  const close = (reason?: DisconnectReason) => {
    if (closed) return;
    closed = true;
    ports.messages.removeEventListener('message', ready);
    for (const dispose of disposers) dispose();
    data?.close(reason);
    pictures?.close(reason);
    ports.messages.close();
    ports.media.close();
    connection?.close();
  };
  const ready = (event: MessageEvent) => {
    if (closed || event.data?.type !== 'ready') return;
    ports.messages.removeEventListener('message', ready);
    data = new CreditPort(
      ports.messages,
      messages,
      commands,
      jsonBytes,
      (value) => {
        const message = clientMessageSchema.parse(value) as ClientMessage;
        connection?.send(message);
      },
      close,
    );
    pictures = new CreditPort(
      ports.media,
      media,
      media,
      mediaBytes,
      () => {
        throw new Error('Unexpected media input');
      },
      () => {},
    );
    try {
      connection = connect();
      disposers.push(connection.subscribe((message) => data!.send(message)));
      if (connection.subscribeMedia)
        disposers.push(
          connection.subscribeMedia((frame) => {
            // Packet readers may share a backing chunk with the next frame. Transfer
            // only owned frame bytes; never detach another packet's buffer.
            const bytes = frame.data.slice();
            return pictures!.send({ header: frame.header, data: bytes }, [
              bytes.buffer,
            ]);
          }),
        );
      disposers.push(connection.onDisconnect(close));
      if (closed) {
        for (const dispose of disposers) dispose();
      }
    } catch {
      close('source_unavailable');
    }
  };
  ports.messages.addEventListener('message', ready);
  ports.messages.start();
  return { close: () => close() };
}
