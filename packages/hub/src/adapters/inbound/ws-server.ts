import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  type ClientMessage,
  ValidationError,
  encodeMessage,
  parseMessage,
  validateClientMessage,
} from '@huddle/protocol';
import type { HubService } from '../../application/hub-service.js';
import { WsMemberChannel } from '../outbound/ws-member-channel.js';

const MAX_FRAME_BYTES = 1_000_000;

export interface WsAdapterOptions {
  token?: string;
}

export function attachWsAdapter(
  httpServer: HttpServer,
  hub: HubService,
  options: WsAdapterOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (options.token && url.searchParams.get('token') !== options.token) {
      socket.send(
        encodeMessage({ t: 'error', id: '', reason: 'bad_request', detail: 'token inválido' }),
      );
      socket.close(4001, 'unauthorized');
      return;
    }

    const channel = new WsMemberChannel(randomUUID(), socket);
    hub.greet(channel);

    socket.on('message', (raw: RawData) => {
      const message = decodeFrame(raw, channel, socket);
      if (message) hub.handle(channel, message);
    });

    socket.on('close', () => hub.disconnect(channel.id));
    socket.on('error', () => socket.terminate());
  });

  return wss;
}

function decodeFrame(
  raw: RawData,
  channel: WsMemberChannel,
  socket: WebSocket,
): ClientMessage | null {
  if (raw instanceof ArrayBuffer || Array.isArray(raw)) return null;
  if (raw.byteLength > MAX_FRAME_BYTES) {
    socket.close(4005, 'frame too large');
    return null;
  }

  const parsed = parseMessage(raw.toString('utf8'));
  if (!parsed) return null;

  try {
    return validateClientMessage(parsed as { t: string } & Record<string, unknown>);
  } catch (error) {
    channel.send({
      t: 'error',
      id: typeof (parsed as { id?: unknown }).id === 'string' ? (parsed as { id: string }).id : '',
      reason: 'bad_request',
      detail: error instanceof ValidationError ? error.message : 'frame inválido',
    });
    return null;
  }
}
