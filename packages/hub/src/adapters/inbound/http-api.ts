import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HubService } from '../../application/hub-service.js';

/**
 * Adaptador de entrada HTTP: salud y transcript.
 *
 * De aquí se cuelga la UI web. Solo mapea rutas a consultas del servicio.
 */
export function createHttpApi(hub: HubService): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      json(response, 200, { ok: true, ...hub.stats() });
      return;
    }

    const transcript = /^\/rooms\/([^/]+)\/transcript$/.exec(url.pathname);
    if (transcript) {
      json(response, 200, hub.transcriptOf(decodeURIComponent(transcript[1]!)));
      return;
    }

    json(response, 404, { error: { code: 'NOT_FOUND', message: 'ruta desconocida' } });
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
