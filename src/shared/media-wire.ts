import { z } from 'zod';

export const MEDIA_WIRE_VERSION = 1;
export const MAX_MEDIA_HEADER_BYTES = 16 * 1024;
export const MAX_MEDIA_FRAME_BYTES = 2 * 1024 * 1024;
export const MEDIA_STREAM_CHUNK_BYTES = 16 * 1024;
const identity = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => !/[\x00\r\n]/.test(value));
export const mediaFrameHeaderSchema = z
  .object({
    version: z.literal(MEDIA_WIRE_VERSION),
    target: identity,
    view: identity,
    stream: identity,
    node: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    track: z.enum(['video', 'audio', 'canvas']),
    codec: z.enum(['vp8', 'h264', 'opus', 'webp']),
    timestamp_us: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    duration_us: z.number().int().min(0).max(1_000_000),
    keyframe: z.boolean(),
    width: z.number().int().min(0).max(8192).optional(),
    height: z.number().int().min(0).max(8192).optional(),
    description: z.string().max(8192).optional(),
    bytes: z.number().int().min(1).max(MAX_MEDIA_FRAME_BYTES),
  })
  .strict()
  .refine((h) =>
    h.track === 'audio'
      ? h.codec === 'opus' && !h.width && !h.height
      : !!h.width &&
        !!h.height &&
        (h.track === 'canvas'
          ? h.codec === 'webp' && h.keyframe
          : h.codec === 'vp8' || h.codec === 'h264'),
  );
export type MediaFrameHeader = z.infer<typeof mediaFrameHeaderSchema>;
export type MediaFrame = { header: MediaFrameHeader; data: Uint8Array };

export function encodeMediaFrame(
  header: MediaFrameHeader,
  data: Uint8Array,
): Uint8Array {
  const parsed = mediaFrameHeaderSchema.safeParse({
    ...header,
    bytes: data.length,
  });
  if (!parsed.success) throw new Error('Invalid media header');
  const metadata = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (metadata.length > MAX_MEDIA_HEADER_BYTES)
    throw new Error('Invalid media header');
  const result = new Uint8Array(4 + metadata.length + data.length);
  new DataView(result.buffer).setUint32(0, metadata.length);
  result.set(metadata, 4);
  result.set(data, 4 + metadata.length);
  return result;
}

/** A bounded incremental reader. It never allocates a payload before validating
 * its complete header, and retains no previously delivered frame bytes. */
export class MediaPacketReader {
  private buffer = new Uint8Array(4);
  private offset = 0;
  private phase: 'length' | 'header' | 'payload' = 'length';
  private header?: MediaFrameHeader;
  push(chunk: Uint8Array): MediaFrame[] {
    const frames: MediaFrame[] = [];
    while (chunk.length) {
      const take = Math.min(this.buffer.length - this.offset, chunk.length);
      this.buffer.set(chunk.subarray(0, take), this.offset);
      this.offset += take;
      chunk = chunk.subarray(take);
      if (this.offset !== this.buffer.length) continue;
      this.offset = 0;
      if (this.phase === 'length') {
        const length = new DataView(this.buffer.buffer).getUint32(0);
        if (!length || length > MAX_MEDIA_HEADER_BYTES)
          throw new Error('Invalid media header length');
        this.buffer = new Uint8Array(length);
        this.phase = 'header';
      } else if (this.phase === 'header') {
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(this.buffer),
          );
        } catch {
          throw new Error('Invalid media header');
        }
        const parsed = mediaFrameHeaderSchema.safeParse(value);
        if (!parsed.success) throw new Error('Invalid media header');
        this.header = parsed.data;
        this.buffer = new Uint8Array(this.header.bytes);
        this.phase = 'payload';
      } else {
        frames.push({ header: this.header!, data: this.buffer });
        this.buffer = new Uint8Array(4);
        this.header = undefined;
        this.phase = 'length';
      }
    }
    return frames;
  }
  finish(): void {
    if (this.offset || this.phase !== 'length')
      throw new Error('Incomplete media packet');
  }
}
