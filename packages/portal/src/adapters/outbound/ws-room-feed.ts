import type { FeedIdentity, PortalClientMessage, RoomFeed } from '../../application/ports/room-feed.js';
import type { PortalEvent } from '../../domain/session-state.js';

export interface WsRoomFeedOptions {
  url: string;
  identity: FeedIdentity;
  token?: string;
  heartbeatMs?: number;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

export class WsRoomFeed implements RoomFeed {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<(event: PortalEvent) => void>();
  private attempts = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly outbox: PortalClientMessage[] = [];
  private createdRoom: string | null = null;

  constructor(private readonly options: WsRoomFeedOptions) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  subscribe(listener: (event: PortalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: PortalClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.outbox.push(message);
  }

  private open(): void {
    if (this.stopped) return;
    this.emit({ t: 'transport', status: 'connecting' });

    const url = new URL(this.options.url);
    if (this.options.token) url.searchParams.set('token', this.options.token);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url.toString());
    } catch (error) {
      this.scheduleReconnect(describe(error));
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      // El `join` (o el `create`) va siempre primero: hasta que el hub no
      // responde `welcome`, no somos nadie en la sala.
      socket.send(JSON.stringify(this.hello()));
      for (const pending of this.outbox.splice(0)) socket.send(JSON.stringify(pending));
      this.startHeartbeat(socket);
    });

    socket.addEventListener('message', (raw: MessageEvent<unknown>) => {
      if (typeof raw.data !== 'string') return;
      const event = toPortalEvent(raw.data);
      if (!event) return;
      if (event.t === 'welcome') this.createdRoom = event.room;
      this.emit(event);
    });

    socket.addEventListener('close', (closed: CloseEvent) => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.socket = null;
      // 4001/4005 son rechazos del hub: reintentar no arregla nada.
      if (closed.code === 4001 || closed.code === 4005) {
        this.stopped = true;
        this.emit({ t: 'transport', status: 'closed', detail: closed.reason || 'rechazado por el hub' });
        return;
      }
      this.scheduleReconnect(closed.reason || undefined);
    });

    socket.addEventListener('error', () => {
      // El evento de error del navegador no dice nada útil; el `close` que
      // viene detrás es el que decide.
    });
  }

  /**
   * El primer frame. Tras una reconexión siempre es `join`, aunque la sesión
   * empezara creando la sala: crear otra vez daría un código distinto y
   * dejaría al usuario en una sala vacía sin enterarse.
   */
  private hello(): PortalClientMessage {
    const { identity } = this.options;
    if (identity.mode === 'create' && this.createdRoom === null) {
      return {
        t: 'create',
        v: 1,
        name: identity.roomName ?? 'sala',
        alias: identity.alias,
        quotaRemaining: null,
      };
    }
    return {
      t: 'join',
      v: 1,
      room: this.createdRoom ?? identity.room,
      alias: identity.alias,
      viewer: identity.viewer,
      quotaRemaining: null,
    };
  }

  private startHeartbeat(socket: WebSocket): void {
    const every = this.options.heartbeatMs ?? 20_000;
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'ping', quotaRemaining: null }));
      }
    }, every);
  }

  private scheduleReconnect(detail?: string): void {
    if (this.stopped) return;
    this.emit(detail ? { t: 'transport', status: 'offline', detail } : { t: 'transport', status: 'offline' });
    const wait = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] ?? 15000;
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.open(), wait);
  }

  private emit(event: PortalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function toPortalEvent(raw: string): PortalEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as { t?: unknown };
  if (typeof message.t !== 'string') return null;

  switch (message.t) {
    case 'welcome':
    case 'room_state':
    case 'host_changed':
    case 'room_closed':
    case 'msg':
    case 'activity':
    case 'result':
    case 'error':
      return parsed as PortalEvent;
    default:
      return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'no se pudo abrir el socket';
}
