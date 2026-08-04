/**
 * Contrato de cables de Huddle.
 *
 * Un solo sobre JSON por frame de WebSocket, discriminado por `t`.
 * El hub solo rutea: nunca lee ni reescribe el contenido de una respuesta.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

/** Alias de un miembro, siempre con `@` (ej. `@ryzeon`). */
export type Alias = string;

/** Destino de una pregunta. */
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

// ---------------------------------------------------------------------------
// Tarjeta de capacidades — qué sabe este agente
// ---------------------------------------------------------------------------

export interface CapabilityCard {
  /** Nombre del repo (basename del cwd o del remote de git). */
  repo: string;
  /** Remote de git, si existe. */
  remote?: string;
  /** Rama actual. */
  branch?: string;
  /** SHA corto del HEAD — acompaña cada respuesta para detectar deriva. */
  sha?: string;
  /**
   * Directorios hasta segundo nivel (`src/auth`, `src/payments`).
   *
   * El segundo nivel es lo que de verdad describe un repositorio: saber que
   * tiene `src` no distingue nada, saber que tiene `src/billing` sí.
   */
  dirs: string[];
  /** Primeras líneas del CLAUDE.md o, si no hay, del README. */
  summary?: string;
  /**
   * Términos sueltos sacados de los manifiestos (package.json, go.mod,
   * pom.xml…): nombre del paquete, descripción, dependencias señaladas.
   * Existen solo para dar al ruteo más superficie donde enganchar.
   */
  keywords?: string[];
}

export interface Member {
  alias: Alias;
  /** true si solo observa (el portal web); no recibe preguntas. */
  viewer?: boolean;
  /** Epoch ms de entrada: decide quién hereda el mando. */
  joinedAt?: number;
  /** Un humano puede tener varios tags: `@ryzeon:api`, `@ryzeon:web`. */
  tag?: string;
  status: 'online' | 'busy' | 'offline';
  card?: CapabilityCard;
  /** Epoch ms de la última señal de vida. */
  lastSeen: number;
  /** Preguntas que aún acepta hoy; `null` si el dueño no puso tope. */
  quotaRemaining: number | null;
}

// ---------------------------------------------------------------------------
// Respuestas — el contrato que `--json-schema` le impone a Claude
// ---------------------------------------------------------------------------

export interface SourceRef {
  file: string;
  line?: number;
}

export interface Answer {
  answer: string;
  sources: SourceRef[];
  /** El modelo se autoevalúa; el hub lo usa para decidir si escala de tier. */
  confidence: 'low' | 'medium' | 'high';
  /** Presente cuando el agente no pudo contestar con lo que tenía a mano. */
  needsEscalation?: boolean;
}

/**
 * Se pasa literal a `claude --json-schema`. Mantenerlo plano y sin `$ref`:
 * los structured outputs no soportan esquemas recursivos.
 */
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

// ---------------------------------------------------------------------------
// Cliente → hub
// ---------------------------------------------------------------------------

/**
 * Crear una sala. El hub devuelve un código único que **sustituye al token**:
 * es la única llave, así que quien lo tiene entra, y quien no, no.
 * Quien crea la sala queda como anfitrión.
 */
export interface CreateRoomMessage {
  t: 'create';
  v: number;
  name: string;
  alias: Alias;
  tag?: string;
  card?: CapabilityCard;
  quotaRemaining: number | null;
}

/** Expulsar a alguien. Solo el anfitrión. */
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
  /**
   * Solo observa: no responde preguntas ni cuenta como agente disponible.
   *
   * Lo usa el portal web. Sin esto tendría que fingir ser un agente, y el
   * ruteo acabaría mandándole preguntas que nadie va a contestar.
   */
  viewer?: boolean;
}

export interface AskMessage {
  t: 'ask';
  id: string;
  to: Target;
  q: string;
  /** Segundos antes de que el hub abandone la pregunta. */
  ttl: number;
}

/** Chat humano normal en la sala. */
export interface ChatMessage {
  t: 'msg';
  from?: Alias;
  text: string;
}

/**
 * Fragmento de respuesta en streaming, del que responde hacia el hub.
 *
 * `from` lo rellena el hub al reenviar: quien responde no lo manda, porque en
 * un `@all` el que pregunta necesita saber cuál de los agentes está hablando.
 */
export interface ChunkMessage {
  t: 'chunk';
  id: string;
  delta: string;
  from?: Alias;
}

/** Línea de estado ("leyendo src/auth.ts") — para que la UI no parezca colgada. */
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
  /** Rama y SHA en los que se produjo la respuesta. */
  branch?: string;
  sha?: string;
  /** Milisegundos de reloj de pared. */
  elapsedMs: number;
  /** true si vino de la caché local, sin gastar cuota. */
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
  | KickMessage
  | JoinMessage
  | AskMessage
  | ChatMessage
  | ChunkMessage
  | TraceMessage
  | ResultMessage
  | ErrorMessage
  | HeartbeatMessage;

// ---------------------------------------------------------------------------
// Hub → cliente
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  t: 'welcome';
  v: number;
  /** Código de la sala: lo que hay que compartir para que entren otros. */
  room: string;
  /** Nombre legible que le puso quien la creó. */
  roomName: string;
  you: Alias;
  /** Quién manda ahora mismo. */
  host: Alias;
  members: Member[];
}

/**
 * Qué está pasando en la sala, para que una interfaz pueda dibujarlo.
 *
 * Se difunde a todos los miembros. **No lleva el contenido de la pregunta ni
 * de la respuesta a propósito**: eso es privado de quien preguntó. Aquí solo
 * viaja quién habla con quién y en qué punto está.
 */
export interface ActivityMessage {
  t: 'activity';
  /** Id de la pregunta, para casar el `asking` con su desenlace. */
  id: string;
  from: Alias;
  to: Alias;
  phase: 'asking' | 'answered' | 'failed';
  elapsedMs?: number;
  cached?: boolean;
}

/** El anfitrión cambió: se fue el anterior y heredó el más antiguo. */
export interface HostChangedMessage {
  t: 'host_changed';
  host: Alias;
  reason: 'left' | 'created';
}

/** Te echaron, o la sala se cerró. En ambos casos no hay que reconectar. */
export interface RoomClosedMessage {
  t: 'room_closed';
  reason: 'kicked' | 'empty';
  detail?: string;
}

export interface RoomStateMessage {
  t: 'room_state';
  members: Member[];
}

/** Pregunta entrante que este agente debe responder. */
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

// ---------------------------------------------------------------------------
// Ids ordenables por tiempo (ULID-lite: 48 bits de ms + 40 de azar)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parseo defensivo — nunca confiar en el otro extremo del socket
// ---------------------------------------------------------------------------

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
