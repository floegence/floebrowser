import { z } from 'zod';
import type { eventWithTime } from '@rrweb/types';

export const PROTOCOL_VERSION = 1;
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
export const UNSUPPORTED_SELECTOR =
  'iframe,frame,canvas,video,audio,object,embed,input[type="file"]';

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
      point,
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
]);
export const clientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('command'),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      epoch: z.string().max(80),
      action: actionSchema,
    })
    .strict(),
  z.object({ type: z.literal('resync') }).strict(),
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
  url: string;
  title: string;
  status: 'loading' | 'ready' | 'closed';
  width: number;
  height: number;
  canGoBack: boolean;
  canGoForward: boolean;
};
export type ServerMessage =
  | { type: 'focus'; epoch: string; focus: FocusState }
  | { type: 'hello'; version: typeof PROTOCOL_VERSION }
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
