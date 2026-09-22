import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import type { SourcePage } from './source.js';
import type { SourceDirectory } from './directory.js';
import { WebSocketServer, WebSocket } from 'ws';
import { type AttachOptions } from './engine.js';
import { BrowserSession, type SessionConnection } from './session.js';
import { NativeMediaBridge, type SourceMediaBridge } from './media-bridge.js';
import { MediaSender } from './media-carrier.js';
import {
  MAX_COMMAND_BYTES,
  MAX_MESSAGE_BYTES,
  clientMessageSchema,
  DISCONNECT_CODES,
} from '../shared/protocol.js';

export interface ProjectionServerOptions {
  uploadLimits?: AttachOptions['uploadLimits'];
  port?: number;
  authorize: AttachOptions['authorize'];
  mediaBridge?: SourceMediaBridge;
  onState?: AttachOptions['onState'];
}

/** Optional loopback demo carrier. Redeven can mount BrowserProjection on its own transport. */
export async function createProjectionServer(
  page: Page | SourcePage | SourceDirectory,
  options: ProjectionServerOptions,
) {
  const base = `/session/${randomBytes(32).toString('base64url')}/`;
  const mediaBridge = options.mediaBridge ?? new NativeMediaBridge();
  const session = await ('list' in page
    ? BrowserSession.open(page, {
        uploadLimits: options.uploadLimits,
        authorize: options.authorize,
        onState: options.onState,
        mediaBridge,
        onMediaFrame: (frame) => active?.sender?.push(frame),
        onMediaRetired: (scope) =>
          active?.sender?.retire(scope.target, scope.view, scope.stream),
        resourceURL: (id, tab) => `${base}assets/${tab}/${id}`,
      })
    : BrowserSession.attach(page, {
        uploadLimits: options.uploadLimits,
        authorize: options.authorize,
        onState: options.onState,
        mediaBridge,
        onMediaFrame: (frame) => active?.sender?.push(frame),
        onMediaRetired: (scope) =>
          active?.sender?.retire(scope.target, scope.view, scope.stream),
        resourceURL: (id, tab) => `${base}assets/${tab}/${id}`,
      }));
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_COMMAND_BYTES,
    perMessageDeflate: false,
  });
  let origin = '';
  let closing = false;
  let disposal: Promise<void> | undefined;
  let admission = Promise.resolve();
  let active:
    | {
        ws: WebSocket;
        mediaToken: string;
        uploadToken: string;
        sender?: MediaSender;
        mediaSocket?: WebSocket;
        connection?: SessionConnection;
        release: () => Promise<void>;
      }
    | undefined;
  const securityHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const respond = (
    response: ServerResponse,
    status: number,
    body: Buffer | string,
    type = 'text/plain; charset=utf-8',
  ) => {
    response.writeHead(status, { ...securityHeaders, 'Content-Type': type });
    response.end(body);
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.headers.host !== new URL(origin).host ||
        !['GET', 'POST'].includes(request.method ?? '') ||
        closing
      ) {
        respond(response, 403, 'Forbidden');
        return;
      }
      const url = new URL(request.url ?? '/', origin);
      if (!url.pathname.startsWith(base) || url.search) {
        respond(response, 404, 'Not found');
        return;
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        respond(response, 403, 'Forbidden');
        return;
      }
      const path = url.pathname.slice(base.length);
      if (path.startsWith('download/') && request.method === 'GET') {
        const [token, tab, id, extra] = path.slice(9).split('/');
        const viewer = active;
        if (
          !viewer?.connection ||
          token !== viewer.uploadToken ||
          !tab ||
          !id ||
          extra ||
          viewer.ws.readyState !== WebSocket.OPEN
        ) {
          respond(response, 403, 'Download unavailable');
          return;
        }
        const abort = new AbortController();
        const canceled = () => {
          if (!response.writableFinished) abort.abort();
        };
        response.on('close', canceled);
        try {
          const file = await viewer.connection.download(tab, id, abort.signal);
          const filename = encodeURIComponent(file.filename).replace(
            /['()*]/g,
            (character) => `%${character.charCodeAt(0).toString(16)}`,
          );
          response.writeHead(200, {
            ...securityHeaders,
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`,
            ...(file.size !== undefined
              ? { 'Content-Length': String(file.size) }
              : {}),
          });
          await pipeline(Readable.from(file.body), response, {
            signal: abort.signal,
          });
        } catch {
          if (!response.headersSent && !response.destroyed)
            respond(response, 404, 'Download unavailable');
          else response.destroy();
        } finally {
          response.off('close', canceled);
        }
        return;
      }
      if (path.startsWith('upload/') && request.method === 'POST') {
        const [token, chooser, extra] = path.slice(7).split('/');
        const viewer = active;
        const metadata = request.headers['x-floe-file'];
        if (
          !viewer?.connection ||
          token !== viewer.uploadToken ||
          !chooser ||
          extra ||
          request.headers.origin !== origin ||
          typeof metadata !== 'string' ||
          metadata.length > 8192 ||
          viewer.ws.readyState !== WebSocket.OPEN
        ) {
          respond(response, 403, 'File transfer unavailable');
          request.resume();
          return;
        }
        const abort = new AbortController();
        const canceled = () => {
          if (!response.writableFinished) abort.abort();
        };
        response.on('close', canceled);
        try {
          const file = JSON.parse(decodeURIComponent(metadata));
          if (request.headers['content-length'] !== String(file.size))
            throw new Error('Upload length mismatch');
          const id = await viewer.connection.upload(
            chooser,
            file,
            request,
            abort.signal,
          );
          respond(response, 200, JSON.stringify({ id }), 'application/json');
        } catch {
          if (!response.destroyed)
            respond(response, 400, 'File transfer rejected');
          request.resume();
        } finally {
          response.off('close', canceled);
        }
        return;
      }
      if (request.method !== 'GET') {
        respond(response, 405, 'Method not allowed');
        request.resume();
        return;
      }
      if (path.startsWith('assets/')) {
        const [tab, id] = path.slice(7).split('/');
        const resource =
          tab && id ? await session.readResource(tab, id) : undefined;
        if (!resource) {
          respond(response, 404, 'Source resource unavailable');
          return;
        }
        respond(response, 200, resource.body, resource.type);
        return;
      }
      const files: Record<string, [string, string]> = {
        '': ['index.html', 'text/html; charset=utf-8'],
        'app.js': ['app.js', 'text/javascript; charset=utf-8'],
        'app.css': ['app.css', 'text/css; charset=utf-8'],
        'style.css': ['style.css', 'text/css; charset=utf-8'],
        'media-worker.js': [
          'media-worker.js',
          'text/javascript; charset=utf-8',
        ],
        'audio-worklet.js': [
          'audio-worklet.js',
          'text/javascript; charset=utf-8',
        ],
      };
      const file = files[path];
      if (!file) {
        respond(response, 404, 'Not found');
        return;
      }
      respond(
        response,
        200,
        await readFile(new URL(`../assets/${file[0]}`, import.meta.url)),
        file[1],
      );
    })().catch(() => {
      if (!response.headersSent) respond(response, 500, 'Request failed');
      else response.end();
    });
  });
  server.on('upgrade', (request, socket, head) => {
    if (
      closing ||
      request.headers.host !== new URL(origin).host ||
      request.headers.origin !== origin ||
      (request.url !== `${base}stream` &&
        request.url !== `${base}stream?takeover=1` &&
        request.url !== `${base}media?token=${active?.mediaToken}`)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit('connection', ws, request),
    );
  });
  sockets.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    if (request.url?.startsWith(`${base}media?`)) {
      const viewer = active;
      if (
        !viewer ||
        viewer.mediaSocket ||
        viewer.ws.readyState !== WebSocket.OPEN
      ) {
        ws.close(1008, 'Media unavailable');
        return;
      }
      viewer.mediaSocket = ws;
      viewer.sender = new MediaSender(
        (chunk) =>
          new Promise<void>((resolve, reject) => {
            if (ws.readyState !== WebSocket.OPEN) {
              reject(new Error('Media disconnected'));
              return;
            }
            ws.send(chunk, (error) => (error ? reject(error) : resolve()));
          }),
        (scope) => session.requestMediaKeyframe(scope),
      );
      void viewer.connection?.setMedia(true);
      ws.on('message', (data, binary) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Buffer.concat(data as Buffer[]);
        if (
          !binary ||
          bytes.length !== 8 ||
          !viewer.sender?.acknowledge(Number(bytes.readBigUInt64BE()))
        )
          ws.close(1008, 'Invalid media credit');
      });
      ws.on('error', () => ws.close());
      ws.on('close', () => {
        viewer.sender?.close();
        viewer.sender = undefined;
        void viewer.connection?.setMedia(false);
      });
      return;
    }
    let controller: SessionConnection | undefined;
    let disconnected = false;
    let released: Promise<void> | undefined;
    const viewer: NonNullable<typeof active> = {
      ws,
      mediaToken: randomBytes(32).toString('base64url'),
      uploadToken: randomBytes(32).toString('base64url'),
      release: (): Promise<void> => {
        if (!released) {
          // Revocation is synchronous; draining source work remains page-local.
          released = controller?.close() ?? Promise.resolve();
          viewer.sender?.close();
          viewer.mediaSocket?.close();
          if (active === viewer) active = undefined;
        }
        return released;
      },
    };
    const early: unknown[] = [];
    ws.on('error', () => {
      ws.close();
    });
    ws.on('close', () => {
      disconnected = true;
      // The engine retains a terminal drain fault. A disconnected carrier has
      // no recipient for the rejection and must not crash healthy sessions.
      if (controller) void viewer.release().catch(() => {});
    });
    ws.on('message', (data) => {
      let input: unknown;
      try {
        input = JSON.parse(data.toString());
      } catch {
        ws.close(1008, 'Invalid message');
        return;
      }
      const parsed = clientMessageSchema.safeParse(input);
      if (!parsed.success) {
        ws.close(1008, 'Invalid command');
        return;
      }
      if (controller) void controller.receive(parsed.data);
      else if (early.length < 8) early.push(parsed.data);
      else ws.close(1008, 'Connection not ready');
    });
    // Only this carrier owns its viewers. Revoke before admission; each page
    // drains old input before its next snapshot. Other tabs remain usable.
    admission = admission
      .then(async () => {
        if (closing || disconnected || ws.readyState !== WebSocket.OPEN) return;
        if (active) {
          if (active.ws.readyState === WebSocket.OPEN) {
            if (request.url !== `${base}stream?takeover=1`) {
              ws.close(
                DISCONNECT_CODES.viewer_in_use,
                'Source active in another window',
              );
              return;
            }
            active.ws.close(
              DISCONNECT_CODES.viewer_replaced,
              'Control moved to another window',
            );
          }
          void active.release().catch(() => {});
        }
        if (closing || disconnected || ws.readyState !== WebSocket.OPEN) return;
        controller = await session.connect(
          (message) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const payload = JSON.stringify(message);
            if (
              Buffer.byteLength(payload) > MAX_MESSAGE_BYTES ||
              ws.bufferedAmount > MAX_MESSAGE_BYTES
            ) {
              ws.close(
                1013,
                'Projection is behind; reconnect for a fresh view',
              );
              return;
            }
            ws.send(payload);
          },
          { media: false },
        );
        viewer.connection = controller;
        active = viewer;
        ws.send(
          JSON.stringify({
            type: 'carrier',
            mediaToken: viewer.mediaToken,
            uploadToken: viewer.uploadToken,
          }),
        );
        if (disconnected || ws.readyState !== WebSocket.OPEN) {
          await viewer.release();
          return;
        }
        for (const message of early)
          void controller.receive(clientMessageSchema.parse(message));
        early.length = 0;
      })
      .catch(() => {
        ws.close(
          session.hasController
            ? DISCONNECT_CODES.viewer_in_use
            : DISCONNECT_CODES.source_unavailable,
          'Source unavailable',
        );
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await session.close();
    if (!options.mediaBridge) await mediaBridge.close();
    sockets.close();
    throw error;
  }
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    session,
    get engine() {
      return session.activeProjection;
    },
    url: `${origin}${base}`,
    close(): Promise<void> {
      return (disposal ??= (async () => {
        closing = true;
        const failures: unknown[] = [];
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        await admission;
        await active?.release().catch((error) => failures.push(error));
        await session.close().catch((error) => failures.push(error));
        if (!options.mediaBridge)
          await mediaBridge.close().catch((error) => failures.push(error));
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (failures.length)
          throw new AggregateError(failures, 'Source cleanup failed');
      })());
    },
  };
}
