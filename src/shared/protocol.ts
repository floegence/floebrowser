import { z } from 'zod';
import type { eventWithTime } from '@rrweb/types';

export const PROTOCOL_VERSION = 10;
export const MAX_VIEWPORT_DIMENSION = 8192;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_PENDING_COMMANDS = 64;
/** Application close codes used only by the optional WebSocket carrier. */
export const DISCONNECT_CODES = {
  viewer_in_use: 4001,
  viewer_replaced: 4002,
  source_unavailable: 4003,
} as const;
export type DisconnectReason = keyof typeof DISCONNECT_CODES;
export const UNSUPPORTED_SELECTOR = 'object,embed,input[type="file"]';

const point = z
  .object({
    node: z.number().int().positive(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();
const modifiers = z.number().int().min(0).max(15);
export const actionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('viewport'),
      width: z.number().int().min(1).max(MAX_VIEWPORT_DIMENSION),
      height: z.number().int().min(1).max(MAX_VIEWPORT_DIMENSION),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pointer'),
      phase: z.enum(['down', 'up', 'move']),
      point,
      button: z.enum(['left', 'middle', 'right']),
      buttons: z.number().int().min(0).max(7),
      modifiers,
      clicks: z.number().int().min(1).max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wheel'),
      point: point.extend({ space: z.literal('viewport') }),
      dx: z.number().min(-4000).max(4000),
      dy: z.number().min(-4000).max(4000),
      modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('key'),
      phase: z.enum(['down', 'up']),
      key: z.string().min(1).max(64),
      code: z.string().max(64),
      modifiers,
    })
    .strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(16000) }).strict(),
  z
    .object({
      kind: z.literal('select'),
      node: z.number().int().positive(),
      values: z.array(z.string().max(4096)).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('navigate'),
      url: z
        .url()
        .max(8192)
        .refine(
          (value) => ['http:', 'https:'].includes(new URL(value).protocol),
          'Only HTTP(S) addresses are supported',
        ),
    })
    .strict(),
  z.object({ kind: z.enum(['back', 'forward', 'reload']) }).strict(),
  z
    .object({
      kind: z.literal('media'),
      node: z.number().int().positive(),
      operation: z.enum(['play', 'pause', 'seek']),
      time: z.number().finite().min(0).max(1e9).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('tab_new') }).strict(),
  z
    .object({
      kind: z.enum(['tab_select', 'tab_close']),
      tab: z.string().min(1).max(80),
    })
    .strict(),
]);
const iceURLSchema = z
  .string()
  .max(2048)
  .regex(/^(stun|stuns|turn|turns):[^\s]+$/i);
export const mediaConfigurationSchema = z
  .object({
    iceServers: z
      .array(
        z
          .object({
            urls: z.union([iceURLSchema, z.array(iceURLSchema).min(1).max(8)]),
            username: z.string().max(1024).optional(),
            credential: z.string().max(2048).optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    iceTransportPolicy: z.enum(['all', 'relay']).default('all'),
  })
  .strict();
export type MediaConfiguration = z.input<typeof mediaConfigurationSchema>;
export const clientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('command'),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      tab: z.string().min(1).max(80),
      epoch: z.string().max(80),
      action: actionSchema,
    })
    .strict(),
  z.object({ type: z.literal('resync') }).strict(),
  z
    .object({
      type: z.literal('media_answer'),
      tab: z.string().min(1).max(80),
      epoch: z.string().min(1).max(80),
      node: z.number().int().positive(),
      stream: z.string().min(1).max(80),
      sdp: z.string().min(1).max(48000),
    })
    .strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type Command = Extract<ClientMessage, { type: 'command' }>;
export const focusSchema = z
  .object({
    node: z.number().int().min(0),
    start: z.number().int().min(0).max(10000000).nullable(),
    end: z.number().int().min(0).max(10000000).nullable(),
    direction: z.enum(['forward', 'backward', 'none']).nullable(),
  })
  .strict();
export type FocusState = z.infer<typeof focusSchema>;
export type BrowserState = {
  id: string;
  url: string;
  title: string;
  status: 'loading' | 'ready' | 'error' | 'closed';
  width: number;
  height: number;
  canGoBack: boolean;
  canGoForward: boolean;
};
export type TabState = {
  active: string;
  tabs: Array<{ id: string; title: string; url: string }>;
};
export const mediaStateSchema = z
  .object({
    id: z.number().int().positive(),
    kind: z.literal('state'),
    stream: z.string().min(1).max(80),
    paused: z.boolean(),
    time: z.number().finite().min(0),
    duration: z.number().finite().min(0),
    muted: z.boolean(),
    volume: z.number().min(0).max(1),
    status: z.enum(['waiting', 'connecting', 'streaming', 'unavailable']),
    reason: z.string().max(180),
  })
  .strict();
export const mediaPacketSchema = z.discriminatedUnion('kind', [
  mediaStateSchema,
  z
    .object({
      kind: z.literal('offer'),
      id: z.number().int().positive(),
      stream: z.string().min(1).max(80),
      sdp: z.string().min(1).max(48000),
    })
    .strict(),
  z
    .object({ kind: z.literal('removed'), id: z.number().int().positive() })
    .strict(),
]);
export type MediaPacket = z.infer<typeof mediaPacketSchema>;
export type MediaState = z.infer<typeof mediaStateSchema>;
export type ServerMessage =
  | { type: 'media'; epoch: string; packet: MediaPacket }
  | { type: 'tabs'; state: TabState }
  | { type: 'focus'; epoch: string; focus: FocusState }
  | {
      type: 'hello';
      version: typeof PROTOCOL_VERSION;
      media: MediaConfiguration;
    }
  | { type: 'state'; state: BrowserState }
  | {
      type: 'snapshot';
      epoch: string;
      sequence: number;
      events: eventWithTime[];
    }
  | { type: 'events'; epoch: string; sequence: number; events: eventWithTime[] }
  | {
      type: 'ack';
      id: number;
      ok: boolean;
      code?:
        | 'stale_view'
        | 'target_unavailable'
        | 'unsupported'
        | 'action_failed'
        | 'navigation_failed'
        | 'busy'
        | 'not_allowed';
    }
  | { type: 'notice'; message: string };

export interface ProjectionConnection {
  send(message: ClientMessage): void;
  subscribe(listener: (message: ServerMessage) => void): () => void;
  onDisconnect(listener: (reason?: DisconnectReason) => void): () => void;
  close(): void;
}
