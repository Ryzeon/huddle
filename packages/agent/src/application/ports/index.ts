/**
 * Puertos de salida del agente.
 *
 * Cada efecto externo es un puerto, y cada puerto modela una *capacidad*, no
 * una tecnología: "algo capaz de responder sobre un repo", no "Claude Code";
 * "algo capaz de hablar con la sala", no "WebSocket". Por eso los casos de uso
 * se prueban con dobles en memoria, sin subprocesos ni sockets.
 */

import type { Alias, SourceRef, Target } from '@huddle/protocol';
import type { CachedAnswer } from '../../domain/answer-cache.js';
import type { QuotaState } from '../../domain/quota.js';

// -- Motor de respuesta ------------------------------------------------------

export interface AnswerRequest {
  question: string;
  askedBy: Alias;
  /** Sesión previa de la que heredar contexto, si la hay. */
  resumeSessionId?: string;
}

export interface AnswerProgress {
  /** Texto legible de la respuesta, conforme se genera. */
  onDelta?: (text: string) => void;
  /** Línea de estado ("leyendo src/auth.ts"). */
  onTrace?: (text: string) => void;
  /** Señal del proveedor sobre límites de uso. */
  onUsageLimit?: (limit: UsageLimit) => void;
}

export interface UsageLimit {
  status: string;
  kind?: string;
  resetsAt?: number;
}

export interface AnswerOutcome {
  ok: boolean;
  answer: string;
  sources: SourceRef[];
  confidence: 'low' | 'medium' | 'high';
  needsEscalation: boolean;
  /** Para poder forkear de aquí la próxima vez. */
  sessionId?: string;
  model?: string;
  turns: number;
  ttftMs?: number;
  durationMs: number;
  error?: string;
}

/**
 * Algo capaz de responder una pregunta sobre el repositorio del dueño.
 *
 * A propósito no dice «Claude»: el contrato es «entra una pregunta y un
 * repositorio, sale una respuesta con fuentes». Hoy el único adaptador es
 * Claude Code, pero Gemini CLI, OpenCode o un motor local por Ollama encajan
 * aquí sin tocar ni el dominio ni el hub — y nada impide que en una misma
 * sala convivan agentes de IA distintas, porque quien pregunta solo ve la
 * respuesta y sus fuentes.
 */
export interface AnswerEnginePort {
  answer(request: AnswerRequest, progress?: AnswerProgress): Promise<AnswerOutcome>;
}

// -- Sala --------------------------------------------------------------------

export interface RoomAnswer {
  answer: string;
  sources: SourceRef[];
  confidence: 'low' | 'medium' | 'high';
  sha?: string;
  branch?: string;
  elapsedMs: number;
  cached: boolean;
  model?: string;
}

/**
 * Algo capaz de hablar con la sala.
 *
 * `connect` recibe los handlers en vez de tomarlos en el constructor: es la
 * operación que empieza a escuchar, así que es el momento natural para decir
 * quién atiende. Eso rompe la circularidad gateway↔servicio sin punteros
 * diferidos ni bus de eventos.
 */
export interface RoomGatewayPort {
  connect(handlers: RoomEventHandlers): void;
  /** Crea la sala en vez de entrar en una. Devuelve el código generado. */
  create(name: string, handlers: RoomEventHandlers): Promise<string>;
  /** Expulsar a alguien. El hub lo rechaza si no eres el anfitrión. */
  kick(alias: Alias, reason?: string): void;
  disconnect(): void;
  isConnected(): boolean;

  announcePresence(quotaRemaining: number | null): void;
  sendChunk(id: string, delta: string): void;
  sendTrace(id: string, text: string): void;
  sendAnswer(id: string, answer: RoomAnswer): void;
  sendFailure(id: string, reason: string, detail: string): void;

  /** Pregunta saliente; resuelve cuando llega respuesta, error o timeout. */
  ask(to: Target, question: string, ttlSeconds: number): Promise<OutboundResult>;

  roster(): RosterEntry[];
}

export interface RosterEntry {
  alias: Alias;
  /** Distingue los repos de una misma persona: `@ryzeon:api`. */
  tag?: string;
  repo?: string;
  status: string;
  quotaRemaining: number | null;
}

export interface OutboundResult {
  ok: boolean;
  from?: Alias;
  answer?: string;
  sources?: SourceRef[];
  confidence?: string;
  sha?: string;
  branch?: string;
  cached?: boolean;
  elapsedMs?: number;
  error?: string;
}

/** Lo que la sala le empuja al agente. Puerto de *entrada*. */
export interface IncomingQuestion {
  id: string;
  from: Alias;
  question: string;
  ttlSeconds: number;
}

export interface RoomEventHandlers {
  onQuestion(question: IncomingQuestion): void;
}

/** Estado de la sala tal como lo ve este agente. */
export interface RoomInfo {
  code: string;
  name: string;
  host: string;
  youAreHost: boolean;
}

/**
 * Lo que un agente publica sobre sí mismo al entrar y en cada latido.
 *
 * Se consulta en el momento del envío, no se guarda: la cuota cambia con cada
 * pregunta, y un valor capturado al construir el gateway llega siempre viejo.
 */
export interface PresenceProvider {
  card(): RepoSnapshot;
  quotaRemaining(): number | null;
}

// -- Repositorio -------------------------------------------------------------

export interface RepoSnapshot {
  repo: string;
  remote?: string;
  branch?: string;
  sha?: string;
  dirs: string[];
  summary?: string;
  keywords?: string[];
}

/** Algo capaz de describir el repositorio expuesto. */
export interface RepoInspectorPort {
  snapshot(): RepoSnapshot;
  currentSha(): string | undefined;
  currentBranch(): string | undefined;
}

/**
 * Algo capaz de proponer con qué otras palabras se podría buscar un
 * repositorio.
 *
 * Es un puerto aparte de `AnswerEnginePort` porque es otra capacidad: aquel
 * lee el repositorio para responder una pregunta, este solo mira la tarjeta y
 * no necesita ver ni un archivo. Que sean dos permite ampliar el vocabulario
 * con un motor distinto del que responde, o no ampliarlo en absoluto.
 */
export interface VocabularyExpanderPort {
  expand(snapshot: RepoSnapshot): Promise<string[]>;
}

// -- Persistencia y observabilidad -------------------------------------------

export interface QuotaStorePort {
  read(): QuotaState | null;
  write(state: QuotaState): void;
}

/**
 * Vocabularios ya calculados, por clave de contenido. Evita gastar una llamada
 * a la suscripción cada vez que arranca el daemon.
 */
export interface VocabularyStorePort {
  read(key: string): string[] | null;
  write(key: string, terms: string[]): void;
}

export interface CacheStorePort {
  read(): CachedAnswer[];
  write(entries: CachedAnswer[]): void;
}

export interface AuditLogPort {
  record(entry: Record<string, unknown>): void;
}

export interface ClockPort {
  now(): number;
}

export const systemClock: ClockPort = { now: () => Date.now() };

export interface LoggerPort {
  info(message: string): void;
  warn(message: string): void;
}
