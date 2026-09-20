import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import { WebSocketServer, WebSocket } from 'ws';
import {
  BrowserProjection,
  type AttachOptions,
  type Controller,
} from './engine.js';
import {
  MAX_COMMAND_BYTES,
  MAX_MESSAGE_BYTES,
  clientMessageSchema,
} from '../shared/protocol.js';

export interface ProjectionServerOptions {
  port?: number;
  authorize: AttachOptions['authorize'];
}

/** Optional loopback demo carrier. Redeven can mount BrowserProjection on its own transport. */
export async function createProjectionServer(
  page: Page,
  options: ProjectionServerOptions,
) {
  const base = `/session/${randomBytes(32).toString('base64url')}/`;
  const engine = await BrowserProjection.attach(page, {
    authorize: options.authorize,
    resourceURL: (id) => `${base}assets/${id}`,
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_COMMAND_BYTES,
    perMessageDeflate: false,
  });
  let origin = '';
  let closing = false;
  const securityHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
        request.method !== 'GET' ||
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
      if (path.startsWith('assets/')) {
        const resource = await engine.resources.read(path.slice(7));
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
      request.url !== `${base}stream`
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit('connection', ws),
    );
  });
  sockets.on('connection', (ws: WebSocket) => {
    let controller: Controller | undefined;
    let disconnected = false;
    const early: unknown[] = [];
    ws.on('error', () => {
      ws.close();
    });
    ws.on('close', () => {
      disconnected = true;
      void controller?.close();
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
    void engine
      .connect((message) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const payload = JSON.stringify(message);
        if (
          Buffer.byteLength(payload) > MAX_MESSAGE_BYTES ||
          ws.bufferedAmount > MAX_MESSAGE_BYTES
        ) {
          ws.close(1013, 'Projection is behind; reconnect for a fresh view');
          return;
        }
        ws.send(payload);
      })
      .then(async (value) => {
        controller = value;
        if (disconnected) {
          await controller.close();
          return;
        }
        for (const message of early)
          await controller.receive(clientMessageSchema.parse(message));
      })
      .catch(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: 'notice',
              message: engine.hasController
                ? 'This source tab already has an active viewer. Close that viewer, then reconnect.'
                : 'The source browser is unavailable. Reconnect after it is ready.',
            }),
          );
        ws.close(1013, 'Source unavailable');
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
    await engine.close();
    sockets.close();
    throw error;
  }
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    engine,
    url: `${origin}${base}`,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await engine.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
