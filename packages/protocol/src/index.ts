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

export interface JoinMessage {
  t: 'join';
  v: number;
  room: string;
  alias: Alias;
  tag?: string;
  card?: CapabilityCard;
  quotaRemaining: number | null;
  viewer?: boolean;
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
    | 'bad_request';
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
  | JoinMessage
  | AskMessage
  | ChatMessage
  | ChunkMessage
  | TraceMessage
  | ResultMessage
  | ErrorMessage
  | HeartbeatMessage;

export interface WelcomeMessage {
  t: 'welcome';
  v: number;
  room: string;
  roomName: string;
  you: Alias;
  host: Alias;
  members: Member[];
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
  reason: 'kicked' | 'empty' | 'closed_by_host';
  detail?: string;
}

export interface RoomStateMessage {
  t: 'room_state';
  members: Member[];
}

export interface RequestMessage {
  t: 'request';
  id: string;
  from: Alias;
  q: string;
  ttl: number;
}

export type ServerMessage =
  | WelcomeMessage
  | ActivityMessage
  | HostChangedMessage
  | RoomClosedMessage
  | RoomStateMessage
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
} from './validate.js';
