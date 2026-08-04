/**
 * Reducción de eventos a estado de sesión. Entra un evento, sale un estado
 * nuevo; no hay DOM ni sockets. El reloj se pasa como argumento (`now`) en vez
 * de leer `Date.now()`, para que los tests sean deterministas.
 *
 * El hub no manda un evento «entró @fulano»: manda el roster entero en cada
 * cambio, así que las entradas y salidas se deducen diffeando el roster contra
 * el anterior.
 */

import type {
  ActivityMessage,
  Alias,
  Member,
  SourceRef,
} from '@huddle/protocol';
import { memberLabel } from './table-layout.js';

/** Fases por las que pasa una pregunta a ojos de la sala. */
export type ActivityPhase = ActivityMessage['phase'];

// ---------------------------------------------------------------------------
// Eventos que entran al reductor
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'closed';

/** Estado del transporte, que no viene del hub sino del propio socket. */
export interface TransportEvent {
  t: 'transport';
  status: ConnectionStatus;
  detail?: string;
}

export interface WelcomeEvent {
  t: 'welcome';
  v: number;
  room: string;
  roomName: string;
  you: Alias;
  host: Alias;
  members: Member[];
}

export interface RoomStateEvent {
  t: 'room_state';
  members: Member[];
}

export interface HostChangedEvent {
  t: 'host_changed';
  host: Alias;
  reason: 'left' | 'created';
}

export interface RoomClosedEvent {
  t: 'room_closed';
  reason: 'kicked' | 'empty';
  detail?: string;
}

export interface ChatEvent {
  t: 'msg';
  from: Alias;
  text: string;
}

/** Respuesta a una pregunta tuya. El contenido no lo ve nadie más. */
export interface ResultEvent {
  t: 'result';
  id: string;
  from?: Alias;
  answer: string;
  sources: SourceRef[];
  confidence: 'low' | 'medium' | 'high';
  elapsedMs: number;
  cached: boolean;
}

export interface ErrorEvent {
  t: 'error';
  id: string;
  from?: Alias;
  reason: string;
  detail?: string;
}

/**
 * Aviso generado por el propio portal (un comando mal escrito, una copia al
 * portapapeles). No viene del hub, pero se cuenta en el mismo hilo para que
 * el usuario no tenga que mirar a dos sitios.
 */
export interface NoteEvent {
  t: 'note';
  text: string;
  tone?: 'system' | 'failed';
}

export type PortalEvent =
  | TransportEvent
  | NoteEvent
  | WelcomeEvent
  | RoomStateEvent
  | HostChangedEvent
  | RoomClosedEvent
  | ChatEvent
  | ActivityMessage
  | ResultEvent
  | ErrorEvent;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** Categorías de entrada del chat de sesión. El tono lo decide `chat-log`. */
export type EntryKind =
  | 'system'
  | 'joined'
  | 'left'
  | 'kicked'
  | 'host'
  | 'message'
  | 'ask'
  | 'answer'
  | 'failed';

export interface LogEntry {
  /** Monótono y determinista: sirve de clave de render. */
  id: string;
  at: number;
  kind: EntryKind;
  /** Quién origina la entrada. */
  alias?: string;
  /** A quién va dirigida, en preguntas y respuestas. */
  target?: string;
  text?: string;
  /** Línea secundaria: duración, motivo, caché. */
  meta?: string;
  sources?: SourceRef[];
}

/** Una pregunta viva o recién terminada, tal y como la ve la mesa. */
export interface Activity {
  id: string;
  from: Alias;
  to: Alias;
  phase: ActivityPhase;
  startedAt: number;
  endedAt?: number;
  elapsedMs?: number;
  cached?: boolean;
}

export interface SessionState {
  status: ConnectionStatus;
  detail?: string;
  room: string | null;
  roomName: string | null;
  you: Alias | null;
  host: Alias | null;
  members: Member[];
  entries: LogEntry[];
  /** Actividades en curso o terminadas hace poco, en orden de llegada. */
  activities: Activity[];
  /** Aliases ocupados respondiendo ahora mismo. */
  busy: string[];
  /** Puesto a true por `room_closed`: no hay que reconectar. */
  closed: boolean;
  /** Contador de entradas; parte del estado para que los ids sean puros. */
  seq: number;
}

/** Cuántas entradas del chat se conservan. Más allá, la ventana no aporta. */
export const MAX_ENTRIES = 400;
/** Cuánto sobrevive una actividad terminada antes de limpiarse de la mesa. */
export const ACTIVITY_TTL_MS = 6000;

export function initialState(): SessionState {
  return {
    status: 'idle',
    room: null,
    roomName: null,
    you: null,
    host: null,
    members: [],
    entries: [],
    activities: [],
    busy: [],
    closed: false,
    seq: 0,
  };
}

// ---------------------------------------------------------------------------
// Reductor
// ---------------------------------------------------------------------------

export function reduce(state: SessionState, event: PortalEvent, now: number): SessionState {
  switch (event.t) {
    case 'transport':
      return reduceTransport(state, event, now);
    case 'note':
      return push(state, now, {
        kind: event.tone === 'failed' ? 'failed' : 'system',
        text: event.text,
      });
    case 'welcome':
      return reduceWelcome(state, event, now);
    case 'room_state':
      return reduceRoomState(state, event, now);
    case 'host_changed':
      return reduceHostChanged(state, event, now);
    case 'room_closed':
      return reduceRoomClosed(state, event, now);
    case 'msg':
      return push(state, now, {
        kind: 'message',
        alias: event.from,
        text: event.text,
      });
    case 'activity':
      return reduceActivity(state, event, now);
    case 'result':
      return push(state, now, {
        kind: 'answer',
        alias: event.from ?? '@?',
        text: event.answer,
        meta: describeAnswer(event.elapsedMs, event.cached, event.confidence),
        sources: event.sources,
      });
    case 'error':
      return push(state, now, {
        kind: 'failed',
        alias: event.from ?? undefined,
        text: errorText(event.reason),
        meta: event.detail ?? undefined,
      });
    default:
      return state;
  }
}

function reduceTransport(state: SessionState, event: TransportEvent, now: number): SessionState {
  if (state.status === event.status && !event.detail) return state;
  const next: SessionState = { ...state, status: event.status };
  if (event.detail !== undefined) next.detail = event.detail;
  else delete next.detail;

  if (event.status === 'offline') {
    return push(next, now, { kind: 'system', text: 'se perdió la conexión con el hub' });
  }
  if (event.status === 'connecting' && state.status === 'offline') {
    return push(next, now, { kind: 'system', text: 'reconectando…' });
  }
  return next;
}

function reduceWelcome(state: SessionState, event: WelcomeEvent, now: number): SessionState {
  const next: SessionState = {
    ...state,
    status: 'online',
    room: event.room,
    roomName: event.roomName,
    you: event.you,
    host: event.host,
    members: [...event.members],
    closed: false,
  };
  delete next.detail;
  return push(next, now, {
    kind: 'system',
    text: `entraste a «${event.roomName}» como ${event.you}`,
    meta: event.room,
  });
}

/**
 * El diff del roster: de aquí salen todos los avisos de entrada y salida.
 *
 * Se compara por etiqueta completa (`@ana:api`), no por alias: una persona
 * puede tener varios repos en la sala y cada uno es un nodo distinto.
 */
function reduceRoomState(state: SessionState, event: RoomStateEvent, now: number): SessionState {
  const before = new Set(state.members.map(memberLabel));
  const after = new Set(event.members.map(memberLabel));

  let next: SessionState = { ...state, members: [...event.members] };

  for (const member of event.members) {
    const label = memberLabel(member);
    if (!before.has(label)) {
      next = push(next, now, { kind: 'joined', alias: label, meta: repoOf(member) });
    }
  }
  for (const member of state.members) {
    const label = memberLabel(member);
    if (!after.has(label)) {
      next = push(next, now, { kind: 'left', alias: label });
    }
  }
  return next;
}

function reduceHostChanged(state: SessionState, event: HostChangedEvent, now: number): SessionState {
  if (state.host === event.host) return { ...state, host: event.host };
  const next: SessionState = { ...state, host: event.host };
  return push(next, now, {
    kind: 'host',
    alias: event.host,
    meta: event.reason === 'left' ? 'heredó el mando' : 'creó la sala',
  });
}

function reduceRoomClosed(state: SessionState, event: RoomClosedEvent, now: number): SessionState {
  const next: SessionState = { ...state, status: 'closed', closed: true, members: [] };
  if (event.detail !== undefined) next.detail = event.detail;
  return push(next, now, {
    kind: event.reason === 'kicked' ? 'kicked' : 'system',
    alias: state.you ?? undefined,
    text: event.reason === 'kicked' ? 'te expulsaron de la sala' : 'la sala se cerró',
    meta: event.detail ?? undefined,
  });
}

function reduceActivity(state: SessionState, event: ActivityMessage, now: number): SessionState {
  const existing = state.activities.find((a) => a.id === event.id);

  if (event.phase === 'asking') {
    const activity: Activity = {
      id: event.id,
      from: event.from,
      to: event.to,
      phase: 'asking',
      startedAt: now,
    };
    const next: SessionState = {
      ...state,
      activities: [...state.activities.filter((a) => a.id !== event.id), activity],
      busy: unique([...state.busy, event.to]),
    };
    return push(next, now, { kind: 'ask', alias: event.from, target: event.to });
  }

  const activity: Activity = {
    id: event.id,
    from: existing?.from ?? event.from,
    to: existing?.to ?? event.to,
    phase: event.phase,
    startedAt: existing?.startedAt ?? now,
    endedAt: now,
  };
  if (event.elapsedMs !== undefined) activity.elapsedMs = event.elapsedMs;
  if (event.cached !== undefined) activity.cached = event.cached;

  const stillBusy = state.activities.some(
    (a) => a.id !== event.id && a.phase === 'asking' && a.to === activity.to,
  );
  const next: SessionState = {
    ...state,
    activities: [...state.activities.filter((a) => a.id !== event.id), activity],
    busy: stillBusy ? state.busy : state.busy.filter((alias) => alias !== activity.to),
  };

  return push(next, now, {
    kind: event.phase === 'answered' ? 'answer' : 'failed',
    alias: activity.to,
    target: activity.from,
    meta: event.phase === 'answered'
      ? describeAnswer(event.elapsedMs, event.cached)
      : (event.elapsedMs !== undefined ? `${formatSeconds(event.elapsedMs)} · sin respuesta` : 'sin respuesta'),
  });
}

/**
 * Descarta actividades terminadas hace más de `ACTIVITY_TTL_MS`. La interfaz
 * lo llama con un temporizador; se queda aquí para que también sea puro.
 */
export function pruneActivities(state: SessionState, now: number): SessionState {
  const kept = state.activities.filter(
    (a) => a.phase === 'asking' || now - (a.endedAt ?? a.startedAt) < ACTIVITY_TTL_MS,
  );
  if (kept.length === state.activities.length) return state;
  return { ...state, activities: kept };
}

// ---------------------------------------------------------------------------
// Consultas derivadas
// ---------------------------------------------------------------------------

/** Todas las etiquetas mencionables de la sala, más los destinos especiales. */
export function mentionables(state: SessionState): string[] {
  const labels = state.members.map(memberLabel);
  return [...labels, '@all', '@auto'];
}

export function isHost(state: SessionState, label: string): boolean {
  return state.host !== null && (label === state.host || label.startsWith(`${state.host}:`));
}

// ---------------------------------------------------------------------------
// Interno
// ---------------------------------------------------------------------------

function push(
  state: SessionState,
  now: number,
  entry: Omit<LogEntry, 'id' | 'at'>,
): SessionState {
  const seq = state.seq + 1;
  const full: LogEntry = { id: `e${seq}`, at: now, ...entry };
  const entries = [...state.entries, full];
  return {
    ...state,
    seq,
    entries: entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries,
  };
}

function repoOf(member: Member): string | undefined {
  return member.card?.repo;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

function describeAnswer(
  elapsedMs: number | undefined,
  cached: boolean | undefined,
  confidence?: string,
): string | undefined {
  const parts: string[] = [];
  if (elapsedMs !== undefined) parts.push(formatSeconds(elapsedMs));
  if (cached) parts.push('caché');
  if (confidence) parts.push(confidence);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

const ERROR_TEXT: Record<string, string> = {
  denied_by_owner: 'el dueño no aceptó la pregunta',
  quota_exceeded: 'cuota agotada',
  timeout: 'se agotó el tiempo',
  target_offline: 'ese agente no está en la sala',
  agent_failed: 'el agente falló al responder',
  rate_limited: 'demasiadas preguntas seguidas',
  bad_request: 'petición inválida',
};

export function errorText(reason: string): string {
  return ERROR_TEXT[reason] ?? reason;
}
