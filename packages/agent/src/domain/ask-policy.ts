import type { Alias } from '@huddle/protocol';
import type { CachedAnswer } from './answer-cache.js';

export type RejectReason =
  | 'denied_by_owner'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'agent_failed';

export type AskDecision =
  | { kind: 'reject'; reason: RejectReason; detail: string }
  | { kind: 'serve-cached'; entry: CachedAnswer }
  | { kind: 'run-agent' };

export interface QuotaVerdict {
  allowed: boolean;
  reason?: 'daily_quota' | 'concurrency';
}

export interface AskContext {
  from: Alias;
  blocked: readonly Alias[];
  /** `false` cuando la suscripción del dueño está al límite. */
  subscriptionHealthy: boolean;
  cacheHit: CachedAnswer | null;
  reserveQuota: () => QuotaVerdict;
  dailyQuota: number | null;
  inFlight: number;
}

export function decideIncoming(context: AskContext): AskDecision {
  if (context.blocked.includes(context.from)) {
    return { kind: 'reject', reason: 'denied_by_owner', detail: `${context.from} está bloqueado` };
  }

  if (!context.subscriptionHealthy) {
    return {
      kind: 'reject',
      reason: 'rate_limited',
      detail: 'la suscripción del dueño está al límite',
    };
  }

  // Antes de la cuota: un acierto no debe costar presupuesto.
  if (context.cacheHit) {
    return { kind: 'serve-cached', entry: context.cacheHit };
  }

  const verdict = context.reserveQuota();
  if (!verdict.allowed) {
    return verdict.reason === 'daily_quota'
      ? {
          kind: 'reject',
          reason: 'quota_exceeded',
          detail: `cuota diaria agotada (${context.dailyQuota ?? '?'}/día)`,
        }
      : {
          kind: 'reject',
          reason: 'rate_limited',
          detail: `ya hay ${context.inFlight} pregunta/s en curso`,
        };
  }

  return { kind: 'run-agent' };
}
