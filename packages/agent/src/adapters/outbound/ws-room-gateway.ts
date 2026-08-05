import { WebSocket } from 'ws';
import {
  type Alias,
  type ClientMessage,
  type IdentityProof,
  type Member,
  PROTOCOL_VERSION,
  type RoomPolicy,
  type ServerMessage,
  type Target,
  encodeMessage,
  identityProofText,
  newId,
  normalizeRoomCode,
  parseMessage,
} from '@huddle/protocol';
import type {
  IdentitySigner,
  LoggerPort,
  OutboundResult,
  PresenceProvider,
  RoomAnswer,
  RoomEventHandlers,
  RoomGatewayPort,
  RoomInfo,
  RosterEntry,
} from '../../application/ports/index.js';

const HEARTBEAT_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const OUTBOUND_GRACE_MS = 5_000;

/**
 * Cierres ante los que reconectar es inútil o dañino.
 *
 * El caso grave es 4003: si dos daemons comparten alias, cada uno expulsa al
 * otro, reconecta y vuelve a expulsarlo — un bucle infinito que quema CPU y
 * machaca el hub. El backoff no lo frena porque cada conexión exitosa lo
 * reinicia. La única salida correcta es rendirse.
 */
export const TERMINAL_CLOSE_CODES: Record<number, string> = {
  4001: 'el hub rechazó la conexión: código de sala desconocido o expirado',
  4002: 'versión de protocolo incompatible con el hub',
  4003: 'otro agente entró con tu mismo alias y tag',
  4006: 'el anfitrión cambió el código de la sala',
  4007: 'ese alias está firmado por otra clave',
  4008: 'el anfitrión no te dejó entrar',
};

export interface RoomGatewayConfig {
  hubUrl: string;
  room: string;
  alias: Alias;
  tag?: string;
  token?: string;
  signer?: IdentitySigner;
  /** Si el hub no reta, cortar en vez de entrar sin firmar. */
  requireSignedJoin?: boolean;
}

/**
 * Cuánto se espera al reto antes de entrar sin firmar.
 *
 * Un hub viejo no manda `challenge` y se quedaría esperando para siempre.
 */
const CHALLENGE_WAIT_MS = 3_000;

interface PendingOutbound {
  resolve: (value: OutboundResult) => void;
  cancelTimeout: () => void;
}

interface PendingRotation {
  id: string;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  cancel: () => void;
}

const ROTATION_TIMEOUT_MS = 15_000;

export class WsRoomGateway implements RoomGatewayPort {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private stopping = false;
  private members: RosterEntry[] = [];

  private readonly outbound = new Map<string, PendingOutbound>();

  private handlers?: RoomEventHandlers;

  onTerminal?: (code: number, reason: string) => void;

  private createName?: string;
  private createPolicy?: RoomPolicy;
  private createResolve?: (code: string) => void;

  private info?: RoomInfo;
  private rotation?: PendingRotation;
  private helloSent = false;
  private challengeSeen = false;
  private challengeTimer?: NodeJS.Timeout;

  /**
   * El código vigente de la sala. No es `config.room`: tras una rotación
   * aquello es un código muerto, y reconectar con él —o firmarlo— falla.
   */
  private code: string;

  constructor(
    private readonly config: RoomGatewayConfig,
    private readonly presence: PresenceProvider,
    private readonly logger: LoggerPort,
  ) {
    this.code = config.room;
  }

  connect(handlers: RoomEventHandlers): void {
    this.handlers = handlers;
    const url = new URL(this.config.hubUrl);
    if (this.config.token) url.searchParams.set('token', this.config.token);

    const socket = new WebSocket(url.toString());
    this.socket = socket;

    this.helloSent = false;
    this.challengeSeen = false;

    socket.on('open', () => {
      this.reconnectAttempts = 0;
      this.logger.info(`conectado a ${this.config.hubUrl} — sala #${this.code}`);
      // El hello ya no sale aquí: primero hay que oír el reto para poder
      // firmarlo. Si no llega, se decide sin él.
      this.challengeTimer = setTimeout(() => {
        if (this.challengeSeen || this.helloSent) return;
        if (this.config.requireSignedJoin) {
          this.stopping = true;
          this.logger.warn('el hub no pidió firma y la configuración la exige; no se entra.');
          this.socket?.close(1000, 'signed join required');
          return;
        }
        this.logger.warn('el hub no pidió firma: se entra sin firmar el alias.');
        this.sendHello();
      }, CHALLENGE_WAIT_MS).unref();
    });

    socket.on('message', (raw) => {
      const message = parseMessage(String(raw));
      if (message) this.receive(message as ServerMessage);
    });

    socket.on('close', (code, reason) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.challengeTimer) clearTimeout(this.challengeTimer);
      if (this.stopping) return;

      const terminal = TERMINAL_CLOSE_CODES[code];
      if (terminal) {
        // Reconectar aquí no arregla nada y puede hacer daño: con 4003, dos
        // daemons con el mismo alias se expulsan mutuamente para siempre.
        this.stopping = true;
        this.logger.warn(`${terminal} — este agente se detiene.`);
        this.onTerminal?.(code, terminal);
        return;
      }

      // Backoff exponencial con techo: si el hub está caído, no lo martillamos.
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
      this.reconnectAttempts += 1;
      this.logger.warn(`desconectado (${code} ${reason.toString()}), reintento en ${delay / 1000}s`);
      setTimeout(() => this.connect(handlers), delay).unref();
    });

    socket.on('error', (error) => this.logger.warn(`error de socket: ${error.message}`));
  }

  disconnect(): void {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.socket?.close(1000, 'shutdown');
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  roster(): RosterEntry[] {
    return this.members;
  }

  room(): RoomInfo | undefined {
    return this.info;
  }

  create(name: string, handlers: RoomEventHandlers, policy?: RoomPolicy): Promise<string> {
    this.createName = name;
    this.createPolicy = policy;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('el hub no respondió al crear la sala')),
        15_000,
      );
      this.createResolve = (code) => {
        clearTimeout(timer);
        resolve(code);
      };
      this.connect(handlers);
    });
  }

  closeRoom(reason?: string): void {
    this.send(reason ? { t: 'close', reason } : { t: 'close' });
  }

  useRoomCode(code: string): void {
    this.code = code;
    if (this.info) this.info.code = code;
  }

  rotateCode(reason?: string): Promise<string> {
    if (!this.isConnected()) {
      return Promise.reject(new Error('el daemon no está conectado al hub'));
    }
    if (this.rotation) {
      return Promise.reject(new Error('ya hay un cambio de código en marcha'));
    }

    const id = newId();
    return new Promise<string>((resolve, reject) => {
      const handle = setTimeout(() => {
        this.rotation = undefined;
        reject(new Error('el hub no respondió al cambiar el código'));
      }, ROTATION_TIMEOUT_MS);

      this.rotation = {
        id,
        resolve,
        reject,
        cancel: () => clearTimeout(handle),
      };
      this.send(reason ? { t: 'rotate', id, reason } : { t: 'rotate', id });
    });
  }

  kick(alias: Alias, reason?: string): void {
    this.send(reason ? { t: 'kick', alias, reason } : { t: 'kick', alias });
  }

  admit(id: string, remember = true): void {
    this.send(remember ? { t: 'admit', id } : { t: 'admit', id, remember: false });
  }

  deny(id: string, reason?: string): void {
    this.send(reason ? { t: 'deny', id, reason } : { t: 'deny', id });
  }

  announcePresence(quotaRemaining: number | null): void {
    this.send({ t: 'ping', quotaRemaining });
  }

  sendChunk(id: string, delta: string): void {
    this.send({ t: 'chunk', id, delta });
  }

  sendTrace(id: string, text: string): void {
    this.send({ t: 'trace', id, text });
  }

  sendAnswer(id: string, answer: RoomAnswer): void {
    this.send({ t: 'result', id, ...answer });
  }

  sendFailure(id: string, reason: string, detail: string): void {
    this.send({
      t: 'error',
      id,
      reason: reason as never, // ya acotado por el dominio
      detail,
    });
  }

  ask(to: Target, question: string, ttlSeconds: number): Promise<OutboundResult> {
    if (!this.isConnected()) {
      return Promise.resolve({ ok: false, error: 'el daemon no está conectado al hub' });
    }

    const id = newId();
    return new Promise<OutboundResult>((resolve) => {
      const handle = setTimeout(() => {
        this.outbound.delete(id);
        resolve({ ok: false, error: `sin respuesta en ${ttlSeconds}s` });
      }, ttlSeconds * 1000 + OUTBOUND_GRACE_MS);

      this.outbound.set(id, { resolve, cancelTimeout: () => clearTimeout(handle) });
      this.send({ t: 'ask', id, to, q: question, ttl: ttlSeconds });
    });
  }

  /**
   * El primer frame. Firma el alias si hay clave y el hub ha retado.
   *
   * El código que se firma es el vigente, no el de la configuración: tras una
   * rotación aquel está muerto, y firmarlo da una firma que no valida y un
   * diagnóstico imposible.
   */
  private sendHello(nonce?: string): void {
    if (this.helloSent) return;
    this.helloSent = true;
    if (this.challengeTimer) clearTimeout(this.challengeTimer);

    const creating = Boolean(this.createName) && !this.info;
    const common = {
      v: PROTOCOL_VERSION,
      alias: this.config.alias,
      tag: this.config.tag,
      card: this.presence.card(),
      quotaRemaining: this.presence.quotaRemaining(),
    };

    const room = normalizeRoomCode(this.code);
    const proof = this.prove(creating ? 'create' : 'join', creating ? '' : room, nonce);

    // Crear solo la primera vez: tras una reconexión la sala ya existe y hay
    // que entrar con su código, no crear otra.
    this.send(
      creating
        ? {
            t: 'create',
            name: this.createName ?? 'sala',
            ...common,
            ...(proof && { proof }),
            ...(this.createPolicy && { policy: this.createPolicy }),
          }
        : { t: 'join', room, ...common, ...(proof && { proof }) },
    );

    // El latido empieza con el hello, no al abrir: latir antes de decir quién
    // eres es hablarle al hub sin haberte presentado.
    this.heartbeat = setInterval(
      () => this.send({ t: 'ping', quotaRemaining: this.presence.quotaRemaining() }),
      HEARTBEAT_MS,
    );
  }

  private prove(
    kind: 'create' | 'join',
    room: string,
    nonce?: string,
  ): IdentityProof | undefined {
    const { signer, alias, tag } = this.config;
    if (!signer || !nonce) return undefined;

    try {
      const text = identityProofText({ kind, room, alias, tag, nonce });
      return { pubkey: signer.publicKey, sig: signer.sign(text), nonce };
    } catch (error) {
      this.logger.warn(`no se pudo firmar el alias: ${String(error)}`);
      return undefined;
    }
  }

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case 'challenge':
        this.challengeSeen = true;
        this.sendHello(message.nonce);
        return;

      case 'welcome': {
        this.code = message.room;
        this.info = {
          code: message.room,
          name: message.roomName,
          host: message.host,
          youAreHost: message.host === message.you,
        };
        this.logger.info(
          `${message.roomName} (${message.room}) — ${message.members.length} miembro/s` +
            (this.info.youAreHost ? ' · eres el anfitrión' : ` · anfitrión: ${message.host}`),
        );
        this.members = toRoster(message.members);
        this.createResolve?.(message.room);
        this.createResolve = undefined;
        return;
      }

      case 'host_changed':
        if (this.info) {
          this.info.host = message.host;
          this.info.youAreHost = message.host === this.config.alias;
        }
        this.logger.info(
          message.host === this.config.alias
            ? 'ahora eres el anfitrión de la sala'
            : `${message.host} es ahora el anfitrión`,
        );
        return;

      case 'waiting_approval':
        this.logger.info(
          `esperando a que ${message.host} te deje entrar en ${message.roomName} ` +
            `(${message.room}). Tu clave: …${message.key}`,
        );
        return;

      case 'join_request':
        this.handlers?.onJoinRequest?.({
          id: message.id,
          alias: message.alias,
          tag: message.tag,
          key: message.key,
          repo: message.card?.repo,
          at: message.at,
          knownAlias: message.knownAlias,
        });
        return;

      case 'join_request_gone':
        this.handlers?.onJoinRequestGone?.(message.id);
        return;

      case 'room_code': {
        this.useRoomCode(message.room);
        this.logger.info(`el código de la sala es ahora ${message.room}`);
        const rotation = this.rotation;
        if (rotation && rotation.id === message.id) {
          this.rotation = undefined;
          rotation.cancel();
          rotation.resolve(message.room);
        }
        return;
      }

      case 'room_closed':
        // Ni expulsado ni con la sala cerrada tiene sentido reconectar.
        this.stopping = true;
        this.logger.warn(message.detail ?? `la sala se cerró (${message.reason})`);
        this.onTerminal?.(message.reason === 'code_rotated' ? 4006 : 4003, message.reason);
        return;

      case 'room_state':
        this.members = toRoster(message.members);
        return;

      case 'request':
        this.handlers?.onQuestion({
          id: message.id,
          from: message.from,
          question: message.q,
          ttlSeconds: message.ttl,
        });
        return;

      case 'result':
        this.settle(message.id, {
          ok: true,
          from: message.from,
          answer: message.answer,
          sources: message.sources,
          confidence: message.confidence,
          sha: message.sha,
          branch: message.branch,
          cached: message.cached,
          elapsedMs: message.elapsedMs,
        });
        return;

      case 'error':
        // Una rotación denegada no es una respuesta pendiente: si pasara por
        // `settle` se perdería, porque su id no está en `outbound`.
        if (this.rotation && this.rotation.id === message.id) {
          const rotation = this.rotation;
          this.rotation = undefined;
          rotation.cancel();
          rotation.reject(
            new Error(`${message.reason}${message.detail ? `: ${message.detail}` : ''}`),
          );
          return;
        }
        this.settle(message.id, {
          ok: false,
          from: message.from,
          error: `${message.reason}${message.detail ? `: ${message.detail}` : ''}`,
        });
        return;

      default:
        // `chunk` y `trace` alimentarían una UI en vivo; el CLI espera el
        // resultado final, así que por ahora se descartan.
        return;
    }
  }

  private settle(id: string, result: OutboundResult): void {
    const pending = this.outbound.get(id);
    if (!pending) return;
    pending.cancelTimeout();
    this.outbound.delete(id);
    pending.resolve(result);
  }

  private send(message: ClientMessage): void {
    if (!this.isConnected()) return;
    this.socket?.send(encodeMessage(message));
  }
}

function toRoster(members: Member[]): RosterEntry[] {
  return members.map((member) => ({
    alias: member.alias,
    tag: member.tag,
    repo: member.card?.repo,
    status: member.status,
    quotaRemaining: member.quotaRemaining,
  }));
}
