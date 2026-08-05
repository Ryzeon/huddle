export const PROTOCOL_VERSION = 1;

export type Alias = string;

export type Target =
  | Alias // un miembro concreto
  | '@all' // fan-out a toda la sala
  | '@auto'; // el hub elige por tarjeta de capacidades

export function normalizeAlias(raw: string): Alias {
  const trimmed = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(trimmed)) {
    throw new Error(
      `alias inválido: "${raw}" (usa 1-32 chars: a-z, 0-9, guion, guion bajo)`,
    );
  }
  return `@${trimmed}`;
}

export function isBroadcastTarget(target: Target): boolean {
  return target === '@all' || target === '@auto';
}

export function normalizeTag(raw: string): string {
  const tag = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tag)) {
    throw new Error(
      `etiqueta inválida: "${raw}" (usa 1-64 chars: a-z, 0-9, guion, guion bajo)`,
    );
  }
  return tag;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Prefijo del texto que se firma. Va dentro de la firma para que una firma de
 * huddle no pueda reutilizarse como firma de otra cosa.
 */
export const IDENTITY_PROOF_CONTEXT = 'huddle-identity-v1';

export interface IdentityProof {
  /** Clave pública Ed25519 en base64url crudo (43 chars). */
  pubkey: string;
  /** Firma en base64url (86 chars). */
  sig: string;
  /** El reto que emitió el hub al abrir el socket. */
  nonce: string;
}

export interface IdentityProofInput {
  kind: 'create' | 'join';
  room: string;
  alias: Alias;
  tag?: string;
  viewer?: boolean;
  nonce: string;
}

/**
 * El texto canónico que se firma. Ata la clave a esta sala, este alias, este
 * tag y este reto: sin `kind`, una firma de `create` valdría como `join`.
 */
export function identityProofText(input: IdentityProofInput): string {
  const fields = [
    input.kind,
    input.room,
    input.alias,
    input.tag ?? '',
    input.viewer ? '1' : '0',
    input.nonce,
  ];
  for (const field of fields) {
    // Un salto de línea en cualquier campo movería la frontera entre campos y
    // dejaría que dos entradas distintas firmaran el mismo texto.
    if (field.includes('\n')) throw new Error('campo con salto de línea en la prueba de identidad');
  }
  return [IDENTITY_PROOF_CONTEXT, ...fields].join('\n');
}

/** Lo que se le enseña a una persona de una clave: los últimos 8 caracteres. */
export function keyTail(pubkey: string): string {
  return pubkey.slice(-8);
}

export interface CapabilityCard {
  repo: string;
  remote?: string;
  branch?: string;
  sha?: string;
  dirs: string[];
  summary?: string;
  keywords?: string[];
}

export interface Member {
  alias: Alias;
  viewer?: boolean;
  joinedAt?: number;
  tag?: string;
  status: 'online' | 'busy' | 'offline';
  card?: CapabilityCard;
  lastSeen: number;
  quotaRemaining: number | null;
  /** Firmó su alias con la clave que la sala ya tenía atada a ese alias. */
  verified?: boolean;
  /** `keyTail` de su clave. Nunca la clave entera. */
  key?: string;
}

export interface SourceRef {
  file: string;
  line?: number;
}

export interface Answer {
  answer: string;
  sources: SourceRef[];
  confidence: 'low' | 'medium' | 'high';
  needsEscalation?: boolean;
}

export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'La respuesta, en el idioma en que se preguntó.',
    },
    sources: {
      type: 'array',
      description: 'Archivos concretos que respaldan la respuesta.',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
        },
        required: ['file'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    needsEscalation: {
      type: 'boolean',
      description:
        'true si no pudiste responder sin explorar más de lo que se te permitió.',
    },
  },
  required: ['answer', 'sources', 'confidence'],
  additionalProperties: false,
} as const;

export interface CreateRoomMessage {
  t: 'create';
  v: number;
  name: string;
  alias: Alias;
  tag?: string;
  card?: CapabilityCard;
  quotaRemaining: number | null;
  proof?: IdentityProof;
}

/** Cierra la sala para todos. Solo el anfitrión. */
export interface CloseRoomMessage {
  t: 'close';
  reason?: string;
}

export interface KickMessage {
  t: 'kick';
  alias: Alias;
  reason?: string;
}

/** Cambia el código de la sala sin recrearla. Solo el anfitrión. */
export interface RotateCodeMessage {
  t: 'rotate';
  id: string;
  reason?: string;
}

export interface JoinMessage {
  t: 'join';
  v: number;
  room: string;
  alias: Alias;
  tag?: string;
  card?: CapabilityCard;
  quotaRemaining: number | null;
  viewer?: boolean;
  proof?: IdentityProof;
}

export interface AskMessage {
  t: 'ask';
  id: string;
  to: Target;
  q: string;
  ttl: number;
}

export interface ChatMessage {
  t: 'msg';
  from?: Alias;
  text: string;
}

export interface ChunkMessage {
  t: 'chunk';
  id: string;
  delta: string;
  from?: Alias;
}

export interface TraceMessage {
  t: 'trace';
  id: string;
  text: string;
  from?: Alias;
}

export interface ResultMessage {
  t: 'result';
  id: string;
  from?: Alias;
  answer: string;
  sources: SourceRef[];
  confidence: Answer['confidence'];
  branch?: string;
  sha?: string;
  /** Milisegundos de reloj de pared. */
  elapsedMs: number;
  cached: boolean;
  model?: string;
}

export interface ErrorMessage {
  t: 'error';
  id: string;
  from?: Alias;
  reason:
    | 'denied_by_owner'
    | 'quota_exceeded'
    | 'timeout'
    | 'target_offline'
    | 'agent_failed'
    | 'rate_limited'
    | 'bad_request'
    | 'identity_mismatch';
  detail?: string;
}

export interface HeartbeatMessage {
  t: 'ping';
  quotaRemaining?: number | null;
}

export type ClientMessage =
  | CreateRoomMessage
  | CloseRoomMessage
  | KickMessage
  | RotateCodeMessage
  | JoinMessage
  | AskMessage
  | ChatMessage
  | ChunkMessage
  | TraceMessage
  | ResultMessage
  | ErrorMessage
  | HeartbeatMessage;

/** El reto. Sale nada más abrir el socket, antes de que nadie diga quién es. */
export interface ChallengeMessage {
  t: 'challenge';
  v: number;
  nonce: string;
}

export interface WelcomeMessage {
  t: 'welcome';
  v: number;
  room: string;
  roomName: string;
  you: Alias;
  host: Alias;
  members: Member[];
  verified?: boolean;
}

export interface ActivityMessage {
  t: 'activity';
  id: string;
  from: Alias;
  to: Alias;
  phase: 'asking' | 'answered' | 'failed';
  elapsedMs?: number;
  cached?: boolean;
}

export interface HostChangedMessage {
  t: 'host_changed';
  host: Alias;
  reason: 'left' | 'created' | 'returned';
}

export interface RoomClosedMessage {
  t: 'room_closed';
  reason: 'kicked' | 'empty' | 'closed_by_host' | 'code_rotated' | 'identity_taken';
  detail?: string;
}

export interface RoomStateMessage {
  t: 'room_state';
  members: Member[];
}

/** El código nuevo. Solo lo reciben las conexiones del anfitrión. */
export interface RoomCodeMessage {
  t: 'room_code';
  id: string;
  room: string;
  previous: string;
  by: Alias;
}

export interface RequestMessage {
  t: 'request';
  id: string;
  from: Alias;
  q: string;
  ttl: number;
}

export type ServerMessage =
  | ChallengeMessage
  | WelcomeMessage
  | ActivityMessage
  | HostChangedMessage
  | RoomClosedMessage
  | RoomStateMessage
  | RoomCodeMessage
  | RequestMessage
  | ChunkMessage
  | TraceMessage
  | ResultMessage
  | ErrorMessage
  | (ChatMessage & { from: Alias })
  | { t: 'pong' };

export type AnyMessage = ClientMessage | ServerMessage;

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(value: number, length: number): string {
  let out = '';
  let n = value;
  for (let i = 0; i < length; i++) {
    out = B32[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

export function newId(): string {
  const time = encodeBase32(Date.now(), 10);
  let rand = '';
  for (let i = 0; i < 8; i++) {
    rand += B32[Math.floor(Math.random() * 32)];
  }
  return time + rand;
}

export function parseMessage(raw: string): AnyMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { t?: unknown }).t !== 'string'
  ) {
    return null;
  }
  return parsed as AnyMessage;
}

export function encodeMessage(msg: AnyMessage): string {
  return JSON.stringify(msg);
}

export {
  LIMITS,
  ValidationError,
  validateClientMessage,
  validateProof,
} from './validate.js';
