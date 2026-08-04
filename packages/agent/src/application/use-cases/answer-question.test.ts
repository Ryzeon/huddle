import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Quota } from '../../domain/quota.js';
import { QuestionCache } from '../../domain/answer-cache.js';
import {
  createMemoryCacheStore,
  createMemoryQuotaStore,
} from '../../adapters/outbound/fs-stores.js';
import { AnswerQuestionUseCase, type AgentSessionState } from './answer-question.js';
import type {
  AnswerEnginePort,
  AnswerOutcome,
  AnswerProgress,
  AnswerRequest,
  AuditLogPort,
  IncomingQuestion,
  LoggerPort,
  RepoInspectorPort,
  RoomAnswer,
  RoomGatewayPort,
  RosterEntry,
  OutboundResult,
} from '../ports/index.js';

/**
 * Antes del refactor esto vivía dentro del daemon, entre un socket y un
 * `spawn`: para probar "la caché no gasta cuota" había que lanzar Claude de
 * verdad. Con los puertos, todo el caso de uso corre en memoria.
 */

class FakeEngine implements AnswerEnginePort {
  calls: AnswerRequest[] = [];
  outcome: AnswerOutcome = {
    ok: true,
    answer: 'está en src/auth.ts',
    sources: [{ file: 'src/auth.ts', line: 10 }],
    confidence: 'high',
    needsEscalation: false,
    sessionId: 'sess-nueva',
    turns: 3,
    durationMs: 1200,
  };
  progressToEmit?: (progress: AnswerProgress) => void;

  answer(request: AnswerRequest, progress: AnswerProgress = {}): Promise<AnswerOutcome> {
    this.calls.push(request);
    this.progressToEmit?.(progress);
    return Promise.resolve(this.outcome);
  }
}

class FakeRoom implements RoomGatewayPort {
  answers: { id: string; answer: RoomAnswer }[] = [];
  failures: { id: string; reason: string; detail: string }[] = [];
  chunks: string[] = [];
  traces: string[] = [];
  presence: (number | null)[] = [];

  connect(): void {}
  create(): Promise<string> {
    return Promise.resolve('TEST1-ROOM1');
  }
  kick(): void {}
  disconnect(): void {}
  isConnected(): boolean {
    return true;
  }
  announcePresence(quotaRemaining: number | null): void {
    this.presence.push(quotaRemaining);
  }
  sendChunk(_id: string, delta: string): void {
    this.chunks.push(delta);
  }
  sendTrace(_id: string, text: string): void {
    this.traces.push(text);
  }
  sendAnswer(id: string, answer: RoomAnswer): void {
    this.answers.push({ id, answer });
  }
  sendFailure(id: string, reason: string, detail: string): void {
    this.failures.push({ id, reason, detail });
  }
  ask(): Promise<OutboundResult> {
    return Promise.resolve({ ok: false, error: 'no usado' });
  }
  roster(): RosterEntry[] {
    return [];
  }
}

const fakeRepo: RepoInspectorPort = {
  snapshot: () => ({ repo: 'repo-api', dirs: ['src'], sha: 'abc123', branch: 'main' }),
  currentSha: () => 'abc123',
  currentBranch: () => 'main',
};

class FakeAudit implements AuditLogPort {
  entries: Record<string, unknown>[] = [];
  record(entry: Record<string, unknown>): void {
    this.entries.push(entry);
  }
  events(): string[] {
    return this.entries.map((e) => String(e.event));
  }
}

const silentLogger: LoggerPort = { info: () => {}, warn: () => {} };

const question: IncomingQuestion = {
  id: 'q1',
  from: '@ryzeon',
  question: '¿dónde está el middleware de autenticación?',
  ttlSeconds: 60,
};

describe('AnswerQuestionUseCase', () => {
  let engine: FakeEngine;
  let room: FakeRoom;
  let audit: FakeAudit;
  let quota: Quota;
  let cache: QuestionCache;
  let state: AgentSessionState;

  const build = (overrides: { blocked?: string[]; dailyQuota?: number | null } = {}) =>
    new AnswerQuestionUseCase(
      {
        engine,
        room,
        repo: fakeRepo,
        quota,
        cache,
        audit,
        clock: { now: () => 1_000_000 },
        logger: silentLogger,
      },
      {
        blocked: overrides.blocked ?? [],
        dailyQuota: overrides.dailyQuota ?? quota.dailyLimit,
        forkFromSession: true,
      },
      state,
    );

  beforeEach(() => {
    engine = new FakeEngine();
    room = new FakeRoom();
    audit = new FakeAudit();
    quota = new Quota(3, 1, { store: createMemoryQuotaStore() });
    cache = new QuestionCache(72, { store: createMemoryCacheStore() });
    state = {};
  });

  test('responde y estampa rama y SHA', async () => {
    await build().execute(question);

    const [sent] = room.answers;
    assert.equal(sent?.answer.answer, 'está en src/auth.ts');
    assert.equal(sent?.answer.sha, 'abc123');
    assert.equal(sent?.answer.branch, 'main');
    assert.equal(sent?.answer.cached, false);
  });

  test('guarda la respuesta en caché para la próxima', async () => {
    await build().execute(question);
    assert.equal(cache.size, 1);
  });

  test('un acierto de caché NO gasta cuota ni lanza el agente', async () => {
    await build().execute(question);
    assert.equal(engine.calls.length, 1);
    const afterFirst = quota.remaining;

    await build().execute({ ...question, id: 'q2' });

    assert.equal(engine.calls.length, 1, 'no debería volver a lanzar el agente');
    assert.equal(quota.remaining, afterFirst, 'la caché no debe costar presupuesto');
    assert.equal(room.answers[1]?.answer.cached, true);
  });

  test('un alias bloqueado se rechaza antes de tocar cuota o caché', async () => {
    await build({ blocked: ['@ryzeon'] }).execute(question);

    assert.equal(room.failures[0]?.reason, 'denied_by_owner');
    assert.equal(engine.calls.length, 0);
    assert.equal(quota.remaining, 3, 'no debería haber consumido nada');
  });

  test('rechaza cuando se agotó la cuota diaria', async () => {
    // Preguntas con vocabulario disjunto: si comparten tokens, la caché las
    // absorbe y nunca llegan a gastar presupuesto.
    const distintas = [
      'como funciona el despliegue en produccion',
      'quien mantiene el modulo de facturacion',
      'donde viven las migraciones de base de datos',
    ];

    const useCase = build();
    for (const [index, texto] of distintas.entries()) {
      await useCase.execute({ ...question, id: `q${index}`, question: texto });
    }
    assert.equal(engine.calls.length, 3, 'las tres deberían haber gastado cuota');

    await useCase.execute({ ...question, id: 'qx', question: 'que hace el rate limiter interno' });

    assert.equal(room.failures.at(-1)?.reason, 'quota_exceeded');
  });

  test('libera la cuota aunque el motor explote', async () => {
    engine.answer = () => Promise.reject(new Error('claude murió'));

    await build().execute(question);

    assert.equal(quota.busy, 0, 'un fallo no debe dejar el hueco de concurrencia tomado');
    assert.equal(room.failures[0]?.reason, 'agent_failed');
    assert.ok(audit.events().includes('exception'));
  });

  test('un error del motor se reporta sin cachear la respuesta', async () => {
    engine.outcome = { ...engine.outcome, ok: false, error: 'se cortó a los 90s' };

    await build().execute(question);

    assert.equal(room.failures[0]?.detail, 'se cortó a los 90s');
    assert.equal(cache.size, 0, 'no se cachea un fallo');
  });

  test('reenvía el streaming y las líneas de progreso a la sala', async () => {
    engine.progressToEmit = (progress) => {
      progress.onTrace?.('leyendo src/auth.ts');
      progress.onDelta?.('está en ');
      progress.onDelta?.('src/auth.ts');
    };

    await build().execute(question);

    assert.deepEqual(room.traces, ['leyendo src/auth.ts']);
    assert.equal(room.chunks.join(''), 'está en src/auth.ts');
  });

  test('aprende la sesión del dueño y la forkea en la siguiente pregunta', async () => {
    const useCase = build();
    await useCase.execute(question);
    assert.equal(engine.calls[0]?.resumeSessionId, undefined, 'la primera no tiene de dónde forkear');

    await useCase.execute({ ...question, id: 'q2', question: 'otra cosa bien distinta' });
    assert.equal(engine.calls[1]?.resumeSessionId, 'sess-nueva');
  });

  test('deja de aceptar preguntas si la suscripción está al límite', async () => {
    engine.progressToEmit = (progress) => {
      progress.onUsageLimit?.({ status: 'exceeded', kind: 'five_hour' });
    };
    const useCase = build();
    await useCase.execute(question);

    await useCase.execute({ ...question, id: 'q2', question: 'algo completamente diferente' });

    assert.equal(room.failures.at(-1)?.reason, 'rate_limited');
    assert.equal(engine.calls.length, 1, 'no debería intentar una segunda vez');
  });

  test('deja rastro en auditoría de cada respuesta', async () => {
    await build().execute(question);
    assert.ok(audit.events().includes('answered'));
  });
});
