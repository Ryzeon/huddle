    import { decideIncoming, type RejectReason } from '../../domain/ask-policy.js';
import type { Quota } from '../../domain/quota.js';
import type { AskQueue } from '../ask-queue.js';
import type { QuestionCache } from '../../domain/answer-cache.js';
import type {
  AnswerEnginePort,
  AuditLogPort,
  ClockPort,
  IncomingQuestion,
  LoggerPort,
  RepoInspectorPort,
  RoomGatewayPort,
  UsageLimit,
} from '../ports/index.js';
import type { Alias } from '@huddle/protocol';

export interface AnswerQuestionDeps {
  engine: AnswerEnginePort;
  room: RoomGatewayPort;
  repo: RepoInspectorPort;
  quota: Quota;
  cache: QuestionCache;
  audit: AuditLogPort;
  clock: ClockPort;
  logger: LoggerPort;
  announceQuota?: QuotaAnnouncer;
  queue?: AskQueue;
}

export type QuotaAnnouncer = (remaining: number | null) => void;

export interface AnswerQuestionConfig {
  blocked: readonly Alias[];
  dailyQuota: number | null;
  forkFromSession: boolean;
}

export interface AgentSessionState {
  ownerSessionId?: string;
  usageLimit?: UsageLimit;
}

export class AnswerQuestionUseCase {
  constructor(
    private readonly deps: AnswerQuestionDeps,
    private readonly config: AnswerQuestionConfig,
    private readonly state: AgentSessionState,
  ) {}

  async execute(incoming: IncomingQuestion): Promise<void> {
    const { room, quota, cache, repo, audit, clock, logger } = this.deps;

    const sha = repo.currentSha();
    const decision = decideIncoming({
      from: incoming.from,
      blocked: this.config.blocked,
      subscriptionHealthy: !this.state.usageLimit || this.state.usageLimit.status === 'allowed',
      cacheHit: cache.lookup(incoming.question, sha),
      reserveQuota: () => {
        const verdict = quota.tryAcquire();
        return verdict.allowed
          ? { allowed: true }
          : { allowed: false, reason: verdict.reason };
      },
      dailyQuota: this.config.dailyQuota,
      inFlight: quota.busy,
    });

    if (decision.kind === 'reject') {
      room.sendFailure(incoming.id, decision.reason, decision.detail);
      audit.record({ event: 'rejected', from: incoming.from, reason: decision.reason });
      return;
    }

    if (decision.kind === 'queue') {
      this.enqueue(incoming, decision.detail);
      return;
    }

    if (decision.kind === 'serve-cached') {
      const entry = decision.entry;
      room.sendAnswer(incoming.id, {
        answer: entry.answer,
        sources: entry.sources,
        confidence: entry.confidence,
        sha: entry.sha,
        branch: entry.branch,
        elapsedMs: 0,
        cached: true,
      });
      logger.info(`↩︎ ${incoming.from}: servido de caché`);
      audit.record({ event: 'cache_hit', from: incoming.from, question: incoming.question });
      return;
    }

    // El hueco ya está reservado por `reserveQuota`.
    return this.serve(incoming);
  }

  /**
   * Responde con el hueco de concurrencia ya cogido. Lo llaman dos caminos: el
   * normal, y la cola cuando le llega el turno; por eso no reserva nada, solo
   * libera al final.
   */
  private async serve(incoming: IncomingQuestion): Promise<void> {
    const { room, quota, repo, audit, clock, logger } = this.deps;
    const sha = repo.currentSha();
    const startedAt = clock.now();
    logger.info(`→ ${incoming.from} pregunta: ${incoming.question.slice(0, 70)}`);

    try {
      await this.runAgent(incoming, sha, startedAt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      room.sendFailure(incoming.id, 'agent_failed' satisfies RejectReason, detail);
      audit.record({ event: 'exception', from: incoming.from, detail });
    } finally {
      quota.release();
      const announce = this.deps.announceQuota;
      if (announce) announce(quota.remaining);
      else room.announcePresence(quota.remaining);

      // Al soltar el hueco, que entre quien esperaba.
      this.deps.queue?.pump(() => quota.tryAcquire().allowed);
    }
  }

  /**
   * Sin cola configurada se rechaza como antes: el comportamiento nuevo es
   * opcional y no cambia el de quien no la inyecta (los tests, por ejemplo).
   */
  private enqueue(incoming: IncomingQuestion, detail: string): void {
    const { room, audit, clock, queue } = this.deps;

    if (!queue) {
      room.sendFailure(incoming.id, 'rate_limited', detail);
      audit.record({ event: 'rejected', from: incoming.from, reason: 'rate_limited' });
      return;
    }

    const position = queue.enqueue({
      id: incoming.id,
      from: incoming.from,
      deadline: clock.now() + incoming.ttlSeconds * 1000,
      run: () => this.serve(incoming),
      drop: (motivo) => {
        room.sendFailure(incoming.id, 'timeout', motivo);
        audit.record({ event: 'dropped', from: incoming.from, detail: motivo });
      },
    });

    if (position === null) {
      room.sendFailure(incoming.id, 'rate_limited', 'hay demasiadas preguntas esperando turno');
      audit.record({ event: 'rejected', from: incoming.from, reason: 'rate_limited' });
      return;
    }

    // Que quien pregunta sepa que no se ha perdido, y cuántos van por delante.
    room.sendTrace(incoming.id, `en cola, ${position} por delante`);
    audit.record({ event: 'queued', from: incoming.from, position });
  }

  private async runAgent(
    incoming: IncomingQuestion,
    sha: string | undefined,
    startedAt: number,
  ): Promise<void> {
    const { engine, room, repo, cache, audit, clock, logger } = this.deps;

    const outcome = await engine.answer(
      {
        question: incoming.question,
        askedBy: incoming.from,
        resumeSessionId: this.config.forkFromSession ? this.state.ownerSessionId : undefined,
      },
      {
        onDelta: (text) => room.sendChunk(incoming.id, text),
        onTrace: (text) => room.sendTrace(incoming.id, text),
        onUsageLimit: (limit) => {
          this.state.usageLimit = limit;
          if (limit.status !== 'allowed') {
            logger.warn(`límite de suscripción: ${limit.status} (${limit.kind ?? '?'})`);
          }
        },
      },
    );

    if (outcome.sessionId) this.state.ownerSessionId = outcome.sessionId;

    if (!outcome.ok) {
      room.sendFailure(incoming.id, 'agent_failed', outcome.error ?? 'el agente falló');
      audit.record({ event: 'agent_failed', from: incoming.from, detail: outcome.error });
      return;
    }

    const branch = repo.currentBranch();
    const elapsedMs = clock.now() - startedAt;

    room.sendAnswer(incoming.id, {
      answer: outcome.answer,
      sources: outcome.sources,
      confidence: outcome.confidence,
      sha,
      branch,
      elapsedMs,
      cached: false,
      model: outcome.model,
    });

    cache.put({
      question: incoming.question,
      answer: outcome.answer,
      sources: outcome.sources,
      confidence: outcome.confidence,
      sha,
      branch,
    });

    logger.info(
      `✓ respondido a ${incoming.from} en ${Math.round(elapsedMs / 1000)}s ` +
        `(${outcome.turns} turnos, ttft ${outcome.ttftMs ?? '?'}ms, ` +
        `quedan ${this.deps.quota.remaining ?? '∞'})`,
    );
    audit.record({
      event: 'answered',
      from: incoming.from,
      question: incoming.question,
      answer: outcome.answer,
      sources: outcome.sources,
      confidence: outcome.confidence,
      elapsedMs,
      turns: outcome.turns,
    });
  }
}
