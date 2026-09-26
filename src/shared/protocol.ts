import type { ResourceAvailable } from './resources.js';
import { z } from 'zod';
import type { eventWithTime } from '@rrweb/types';
import type { MEDIA_WIRE_VERSION, MediaFrame } from './media-wire.js';

export const PROTOCOL_VERSION = 24;
export const MAX_VIEWPORT_DIMENSION = 8192;
export const MIN_PAGE_ZOOM = 0.25;
export const MAX_PAGE_ZOOM = 5;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_PENDING_COMMANDS = 64;
/** Application close codes used only by the optional WebSocket carrier. */
export const DISCONNECT_CODES = {
  viewer_in_use: 4001,
  viewer_replaced: 4002,
  source_unavailable: 4003,
  version_mismatch: 4004,
} as const;
export type DisconnectReason = keyof typeof DISCONNECT_CODES;
// Only resource-free, untyped objects expose ordinary fallback HTML. A type
// alone can create a browsing context, even without a data URL.
export const UNSUPPORTED_SELECTOR =
  'object:is([data]:not([data=""]),[type]:not([type=""])),embed';

export type UploadFile = { name: string; size: number; relativePath?: string };
export type FileChooserState = {
  id: string;
  target: string;
  url: string;
  multiple: boolean;
  directory: boolean;
  accept: string;
  maxBytes: number;
  maxFiles: number;
};
export type DownloadState = {
  id: string;
  filename: string;
  status: 'receiving' | 'complete' | 'canceled' | 'failed';
  received: number;
  size?: number;
};
export type DownloadFile = {
  filename: string;
  size?: number;
  body: AsyncIterable<Uint8Array>;
};

const point = z
  .object({
    node: z.number().int().positive(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();
const modifiers = z.number().int().min(0).max(15);
export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('release_input') }).strict(),
  z
    .object({
      kind: z.literal('download_cancel'),
      download: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file_reply'),
      chooser: z.string().min(1).max(80),
      files: z
        .array(z.string().regex(/^[a-zA-Z0-9_-]{32}$/))
        .max(128)
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('zoom'),
      factor: z.number().min(MIN_PAGE_ZOOM).max(MAX_PAGE_ZOOM),
    })
    .strict(),
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
      point: point.extend({ space: z.literal('viewport').optional() }),
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
  z.object({ kind: z.enum(['back', 'forward', 'reload', 'stop']) }).strict(),
  z
    .object({
      kind: z.literal('find'),
      query: z.string().min(1).max(512),
      backwards: z.boolean(),
      restart: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dialog_reply'),
      dialog: z.string().min(1).max(80),
      accept: z.boolean(),
      text: z.string().max(16000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('media'),
      node: z.number().int().positive(),
      operation: z.enum(['play', 'pause', 'seek', 'reveal', 'mute']),
      time: z.number().finite().min(0).max(1e9).optional(),
      muted: z.boolean().optional(),
    })
    .strict()
    .refine((action) =>
      action.operation === 'mute'
        ? action.muted !== undefined && action.time === undefined
        : action.muted === undefined,
    ),
  z.object({ kind: z.enum(['tab_new', 'tab_restore']) }).strict(),
  z
    .object({
      kind: z.literal('tab_pin'),
      tab: z.string().min(1).max(80),
      pinned: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tab_move'),
      tab: z.string().min(1).max(80),
      before: z.string().min(1).max(80).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['tab_select', 'tab_close']),
      tab: z.string().min(1).max(80),
    })
    .strict(),
]);
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
      type: z.literal('media_keyframe'),
      tab: z.string().min(1).max(80),
      view: z.string().min(1).max(80),
      stream: z.string().min(1).max(80),
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
  loading: boolean;
  zoom: number;
  width: number;
  height: number;
  canGoBack: boolean;
  canGoForward: boolean;
};
export type DialogState = {
  id: string;
  /** Only a host-authorized tab close may request this decision without input. */
  authority?: 'directory';
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  url: string;
  message: string;
  defaultPrompt: string;
  truncated: boolean;
};
export type TabState = {
  active: string;
  tabs: Array<{
    id: string;
    title: string;
    url: string;
    pinned?: boolean;
    loading?: boolean;
  }>;
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
const mediaRemovedSchema = z
  .object({ kind: z.literal('removed'), id: z.number().int().positive() })
  .strict();
export const mediaPacketSchema = z.discriminatedUnion('kind', [
  mediaStateSchema,
  mediaRemovedSchema,
]);
/** Source-local recorder signaling. Never sent to a remote viewer. */
export const sourceMediaPacketSchema = z.discriminatedUnion('kind', [
  mediaStateSchema,
  mediaRemovedSchema,
  z
    .object({
      kind: z.literal('offer'),
      id: z.number().int().positive(),
      stream: z.string().min(1).max(80),
      sdp: z.string().min(1).max(48000),
    })
    .strict(),
]);
export type SourceMediaPacket = z.infer<typeof sourceMediaPacketSchema>;
export type MediaPacket = z.infer<typeof mediaPacketSchema>;
export type MediaState = z.infer<typeof mediaStateSchema>;
export type NoticeCode =
  | 'file_unavailable'
  | 'dom_limit'
  | 'dom_update_failed'
  | 'popup_unavailable'
  | 'download_unavailable'
  | 'resource_limit'
  | 'tab_unavailable';
export type ServerMessage =
  | { type: 'resource'; target: string; resource: ResourceAvailable }
  | { type: 'downloads'; target: string; items: DownloadState[] }
  | { type: 'file_chooser'; target: string; chooser: FileChooserState | null }
  | {
      type: 'find';
      target: string;
      epoch: string;
      query: string;
      found: boolean;
    }
  | { type: 'dialog'; target: string; dialog: DialogState | null }
  | { type: 'control'; target: string; active: boolean }
  | { type: 'session_access'; editTabs: boolean; restoreTabs?: boolean }
  | { type: 'media_end'; target: string; view: string }
  | {
      type: 'media';
      target: string;
      epoch: string;
      view: string;
      packet: MediaPacket;
    }
  | { type: 'tabs'; state: TabState }
  | { type: 'focus'; epoch: string; focus: FocusState }
  | {
      type: 'hello';
      version: typeof PROTOCOL_VERSION;
      mediaWireVersion: typeof MEDIA_WIRE_VERSION;
    }
  | { type: 'state'; state: BrowserState }
  | {
      type: 'snapshot';
      resources: ResourceAvailable[];
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
        | 'target_changed'
        | 'target_unavailable'
        | 'unsupported'
        | 'action_failed'
        | 'navigation_failed'
        | 'busy'
        | 'not_allowed';
    }
  | { type: 'notice'; code: NoticeCode };

export interface ProjectionConnection {
  /** Save one observed source download through the host carrier/native UI. */
  download?(target: string, id: string, signal: AbortSignal): Promise<void>;
  /** Independent binary upload lane; the host authenticates and binds it to
   * the exact controller and chooser. No data is sent to the website directly. */
  upload?(
    request: FileChooserState,
    file: File,
    signal: AbortSignal,
  ): Promise<string>;
  send(message: ClientMessage): void;
  /** Credit-aware carriers await listeners before reading or acknowledging more.
   * Event-only carriers must independently bound their pending delivery. */
  subscribe(
    listener: (message: ServerMessage) => void | Promise<void>,
  ): () => void;
  subscribeMedia?(
    listener: (frame: MediaFrame) => void | Promise<void>,
  ): () => void;
  onDisconnect(listener: (reason?: DisconnectReason) => void): () => void;
  close(): void;
}
