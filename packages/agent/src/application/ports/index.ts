import type { Alias, SourceRef, Target } from '@huddle/protocol';
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

export interface RoomGatewayPort {
  connect(handlers: RoomEventHandlers): void;
  create(name: string, handlers: RoomEventHandlers): Promise<string>;
  kick(alias: Alias, reason?: string): void;
  disconnect(): void;
  isConnected(): boolean;

  announcePresence(quotaRemaining: number | null): void;
  sendChunk(id: string, delta: string): void;
  sendTrace(id: string, text: string): void;
  sendAnswer(id: string, answer: RoomAnswer): void;
  sendFailure(id: string, reason: string, detail: string): void;

  ask(to: Target, question: string, ttlSeconds: number): Promise<OutboundResult>;

  roster(): RosterEntry[];
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

export interface RoomEventHandlers {
  onQuestion(question: IncomingQuestion): void;
}

export interface RoomInfo {
  code: string;
  name: string;
  host: string;
  youAreHost: boolean;
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
