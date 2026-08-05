import type {
  Alias,
  FolderEntry,
  FolderWrite,
  RoomPolicy,
  SourceRef,
  Target,
} from '@huddle/protocol';
import type { CachedAnswer } from '../../domain/answer-cache.js';
import type { QuotaState } from '../../domain/quota.js';

export interface AnswerRequest {
  question: string;
  askedBy: Alias;
  resumeSessionId?: string;
}

export interface AnswerProgress {
  onDelta?: (text: string) => void;
  onTrace?: (text: string) => void;
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
  sessionId?: string;
  model?: string;
  turns: number;
  ttftMs?: number;
  durationMs: number;
  error?: string;
}

export interface AnswerEnginePort {
  answer(request: AnswerRequest, progress?: AnswerProgress): Promise<AnswerOutcome>;
}

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
 * Lo que se decide al crear una sala y ya no cambia: quién entra, quién
 * escribe en la carpeta y si las respuestas se recuerdan.
 */
export interface RoomOptions {
  policy?: RoomPolicy;
  folderWrite?: FolderWrite;
  folderMemory?: boolean;
}

export interface RoomGatewayPort {
  connect(handlers: RoomEventHandlers): void;
  create(name: string, handlers: RoomEventHandlers, options?: RoomOptions): Promise<string>;
  kick(alias: Alias, reason?: string): void;
  /** Deja entrar a quien espera. Siempre por id de solicitud, nunca por alias. */
  admit(id: string, remember?: boolean): void;
  deny(id: string, reason?: string): void;
  /** Cierra la sala para todos. El hub solo lo acepta del anfitrión. */
  closeRoom(reason?: string): void;
  /** Pide un código nuevo. Resuelve con el que devuelva el hub. */
  rotateCode(reason?: string): Promise<string>;
  /** Fija el código con el que reconectar. */
  useRoomCode(code: string): void;
  room(): RoomInfo | undefined;
  disconnect(): void;
  isConnected(): boolean;

  announcePresence(quotaRemaining: number | null): void;
  sendChunk(id: string, delta: string): void;
  sendTrace(id: string, text: string): void;
  sendAnswer(id: string, answer: RoomAnswer): void;
  sendFailure(id: string, reason: string, detail: string): void;

  ask(to: Target, question: string, ttlSeconds: number): Promise<OutboundResult>;

  roster(): RosterEntry[];

  /** La carpeta de la sala, tal como la anunció el hub. */
  folder(): FolderEntry[];
  putFile(path: string, text: string): Promise<void>;
  dropFile(path: string): Promise<void>;
  fetchFile(path: string): Promise<string>;
}

export interface RosterEntry {
  alias: Alias;
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

export interface IncomingQuestion {
  id: string;
  from: Alias;
  question: string;
  ttlSeconds: number;
}

export interface JoinRequestInfo {
  id: string;
  alias: Alias;
  tag?: string;
  /** La cola de su clave, para leérsela a la persona antes de decidir. */
  key: string;
  repo?: string;
  at: number;
  knownAlias?: Alias;
}

export interface RoomEventHandlers {
  onQuestion(question: IncomingQuestion): void;
  onJoinRequest?(request: JoinRequestInfo): void;
  onJoinRequestGone?(id: string): void;
  /** La carpeta cambió. Solo lo escucha un repositorio: ver el composition root. */
  onFolderState?(entries: FolderEntry[]): void;
}

/**
 * La copia local de la carpeta de la sala.
 *
 * Es una réplica, no la fuente: el hub manda. La excepción es `notas/`, que se
 * puede editar a mano y sube sola — por eso el puerto sabe decir si un archivo
 * está `dirty`, o sea, si su contenido en disco ya no es el que se bajó.
 */
export interface LocalFolderEntry {
  path: string;
  /** El `at` que traía el hub cuando se bajó. */
  syncedAt: number;
  /** En disco hay algo distinto de lo que se bajó: alguien lo editó. */
  dirty: boolean;
}

export interface FolderCachePort {
  /** Dónde vive la copia. Es lo que se le pasa al motor con `--add-dir`. */
  readonly dir: string;
  list(): LocalFolderEntry[];
  read(path: string): string | undefined;
  /** Escribe el archivo y lo da por sincronizado en `at`. */
  save(path: string, text: string, at: number): void;
  remove(path: string): void;
  /** Aparta una edición local que perdió contra el hub, sin borrarla. */
  keepAside(path: string): string | undefined;
}

export interface RoomInfo {
  code: string;
  name: string;
  host: string;
  youAreHost: boolean;
}

export interface IdentitySigner {
  publicKey: string;
  sign(text: string): string;
}

export interface PresenceProvider {
  card(): RepoSnapshot;
  quotaRemaining(): number | null;
}

export interface RepoSnapshot {
  repo: string;
  remote?: string;
  branch?: string;
  sha?: string;
  dirs: string[];
  summary?: string;
  keywords?: string[];
}

export interface RepoInspectorPort {
  snapshot(): RepoSnapshot;
  currentSha(): string | undefined;
  currentBranch(): string | undefined;
}

export interface VocabularyExpanderPort {
  expand(snapshot: RepoSnapshot): Promise<string[]>;
}

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
