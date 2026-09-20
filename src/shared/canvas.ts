export const CANVAS_CHANNEL = 'floe-canvas-v1';
export const MAX_CANVAS_BYTES = 1024 * 1024;
export const CANVAS_CHUNK_BYTES = 16 * 1024;
export const CANVAS_HEADER_BYTES = 20;

/** Unreliable unordered delivery: assembling a newer frame discards the old one. */
export class CanvasFrames {
  private latest = 0;
  private frame?: {
    id: number;
    width: number;
    height: number;
    bytes: Uint8Array;
    chunks: Set<number>;
  };
  receive(
    packet: ArrayBuffer,
  ): { width: number; height: number; bytes: Uint8Array } | undefined {
    if (
      packet.byteLength <= CANVAS_HEADER_BYTES ||
      packet.byteLength > CANVAS_HEADER_BYTES + CANVAS_CHUNK_BYTES
    )
      return;
    const header = new DataView(packet);
    const id = header.getUint32(0),
      width = header.getUint32(4),
      height = header.getUint32(8);
    const size = header.getUint32(12),
      offset = header.getUint32(16);
    const length = packet.byteLength - CANVAS_HEADER_BYTES;
    if (
      !id ||
      !width ||
      !height ||
      width > 32768 ||
      height > 32768 ||
      !size ||
      size > MAX_CANVAS_BYTES ||
      offset % CANVAS_CHUNK_BYTES ||
      offset + length > size ||
      length !== Math.min(CANVAS_CHUNK_BYTES, size - offset)
    )
      return;
    if (id < this.latest || (id === this.latest && !this.frame)) return;
    if (id > this.latest) {
      this.latest = id;
      this.frame = {
        id,
        width,
        height,
        bytes: new Uint8Array(size),
        chunks: new Set(),
      };
    }
    const frame = this.frame;
    if (
      !frame ||
      frame.width !== width ||
      frame.height !== height ||
      frame.bytes.length !== size
    )
      return;
    frame.bytes.set(new Uint8Array(packet, CANVAS_HEADER_BYTES), offset);
    frame.chunks.add(offset);
    if (frame.chunks.size !== Math.ceil(size / CANVAS_CHUNK_BYTES)) return;
    this.frame = undefined;
    return frame;
  }
}
