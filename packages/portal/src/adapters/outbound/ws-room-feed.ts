import { identityProofText, normalizeRoomCode } from '@huddle/protocol';
import type { FeedIdentity, PortalClientMessage, RoomFeed } from '../../application/ports/room-feed.js';
import type { PortalEvent } from '../../domain/session-state.js';
import type { PortalIdentity } from './webcrypto-identity.js';

export interface WsRoomFeedOptions {
  url: string;
  identity: FeedIdentity;
  token?: string;
  heartbeatMs?: number;
  /** Sin clave se entra sin firmar, y solo donde el alias esté libre. */
  signer?: PortalIdentity | null;
}

/** Si el hub no reta en este tiempo, se entra sin firmar. */
const CHALLENGE_WAIT_MS = 3_000;

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

const TERMINAL_CLOSE: Record<number, string> = {
  4001: 'código de sala desconocido o expirado',
  4002: 'versión de protocolo incompatible con el hub',
  4003: 'te expulsaron de la sala',
  4005: 'el hub rechazó la conexión',
  4006: 'el anfitrión cambió el código de la sala',
  4007: 'ese alias está firmado por otra clave',
  4008: 'el anfitrión no te dejó entrar',
};

export class WsRoomFeed implements RoomFeed {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<(event: PortalEvent) => void>();
  private attempts = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly outbox: PortalClientMessage[] = [];
  private createdRoom: string | null = null;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private helloSent = false;

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

    this.helloSent = false;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      // El hello espera al reto: hasta que el hub no manda un nonce no hay
      // nada que firmar. Si no llega, se entra sin firmar.
      this.challengeTimer = setTimeout(() => void this.sendHello(socket), CHALLENGE_WAIT_MS);
    });

    socket.addEventListener('message', (raw: MessageEvent<unknown>) => {
      if (typeof raw.data !== 'string') return;

      const challenge = toChallenge(raw.data);
      if (challenge) {
        void this.sendHello(socket, challenge);
        return;
      }

      const event = toPortalEvent(raw.data);
      if (!event) return;
      // Tras una rotación hay que reconectar con el código nuevo: guardar solo
      // el del `welcome` dejaría al anfitrión reentrando en una sala que ya no
      // responde a ese código.
      if (event.t === 'welcome' || event.t === 'room_code') this.createdRoom = event.room;
      this.emit(event);
    });

    socket.addEventListener('close', (closed: CloseEvent) => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.challengeTimer) clearTimeout(this.challengeTimer);
      this.heartbeatTimer = null;
      this.challengeTimer = null;
      this.socket = null;
      // Cierres del hub que reintentar no arregla. El 4003 es la expulsión:
      // sin esto, a quien echas se le reconecta el portal solo y vuelve a
      // entrar, que es tanto como no haberlo expulsado.
      const terminal = TERMINAL_CLOSE[closed.code];
      if (terminal) {
        this.stopped = true;
        this.emit({ t: 'transport', status: 'closed', detail: closed.reason || terminal });
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
   *
   * Es el único punto asíncrono del feed, porque firmar con WebCrypto lo es.
   */
  private async sendHello(socket: WebSocket, nonce?: string): Promise<void> {
    if (this.helloSent) return;
    this.helloSent = true;
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.challengeTimer = null;

    const hello = await this.hello(nonce);
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(hello));
    for (const pending of this.outbox.splice(0)) socket.send(JSON.stringify(pending));
    this.startHeartbeat(socket);
  }

  private async hello(nonce?: string): Promise<PortalClientMessage> {
    const { identity } = this.options;
    const creating = identity.mode === 'create' && this.createdRoom === null;
    const room = normalizeRoomCode(this.createdRoom ?? identity.room);

    const proof = await this.prove(
      creating ? 'create' : 'join',
      creating ? '' : room,
      creating ? undefined : identity.viewer,
      nonce,
    );

    if (creating) {
      return {
        t: 'create',
        v: 1,
        name: identity.roomName ?? 'sala',
        alias: identity.alias,
        quotaRemaining: null,
        ...(proof && { proof }),
        ...(identity.policy && proof && { policy: identity.policy }),
        ...(identity.folderWrite === 'host' && { folderWrite: 'host' as const }),
        // Solo viaja el `false`: la memoria va encendida por defecto.
        ...(identity.folderMemory === false && { folderMemory: false }),
      };
    }
    return {
      t: 'join',
      v: 1,
      room,
      alias: identity.alias,
      viewer: identity.viewer,
      quotaRemaining: null,
      ...(proof && { proof }),
    };
  }

  private async prove(
    kind: 'create' | 'join',
    room: string,
    viewer: boolean | undefined,
    nonce?: string,
  ): Promise<{ pubkey: string; sig: string; nonce: string } | undefined> {
    const signer = this.options.signer;
    if (!signer || !nonce) return undefined;

    try {
      const text = identityProofText({
        kind,
        room,
        alias: this.options.identity.alias,
        viewer,
        nonce,
      });
      return { pubkey: signer.publicKey, sig: await signer.sign(text), nonce };
    } catch {
      return undefined;
    }
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
    case 'room_code':
    case 'waiting_approval':
    case 'join_request':
    case 'join_request_gone':
    case 'msg':
    case 'activity':
    case 'result':
    case 'error':
    case 'folder_state':
    case 'folder_file':
    case 'folder_ok':
      return parsed as PortalEvent;
    default:
      return null;
  }
}

/** El reto no es un evento de sesión: no pasa por el reductor. */
export function toChallenge(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { t?: unknown; nonce?: unknown };
    if (parsed?.t !== 'challenge' || typeof parsed.nonce !== 'string') return null;
    return parsed.nonce;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'no se pudo abrir el socket';
}
