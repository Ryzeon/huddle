/**
 * Presupuesto de preguntas entrantes.
 *
 * Bajo suscripción, la moneda no son dólares: es la cuota del plan del dueño.
 * Si la sala se la come, el dueño se queda sin poder trabajar — y desinstala.
 * Por eso el tope es local, del dueño, y por defecto conservador.
 */

export interface QuotaState {
  day: string;
  used: number;
}

import type { QuotaStorePort } from '../application/ports/index.js';

export type QuotaStore = QuotaStorePort;

export interface QuotaDeps {
  store: QuotaStore;
  now?: () => Date;
}

export type QuotaDecision =
  | { allowed: true; remaining: number | null }
  | { allowed: false; reason: 'daily_quota' | 'concurrency'; remaining: number };

export function dayKey(date: Date): string {
  // Día local, no UTC: el usuario razona en su huso, no en el del servidor.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class Quota {
  private readonly store: QuotaStore;
  private readonly now: () => Date;
  private state: QuotaState;

  readonly dailyLimit: number | null;
  readonly maxConcurrent: number;

  private inFlight = 0;

  constructor(dailyLimit: number | null, maxConcurrent: number, deps: QuotaDeps) {
    this.dailyLimit = dailyLimit;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.state = this.store.read() ?? { day: dayKey(this.now()), used: 0 };
    this.rollOver();
  }

  private rollOver(): void {
    const today = dayKey(this.now());
    if (this.state.day !== today) {
      this.state = { day: today, used: 0 };
      this.store.write(this.state);
    }
  }

  get remaining(): number | null {
    this.rollOver();
    if (this.dailyLimit === null) return null;
    return Math.max(0, this.dailyLimit - this.state.used);
  }

  get busy(): number {
    return this.inFlight;
  }

  tryAcquire(): QuotaDecision {
    this.rollOver();

    if (this.inFlight >= this.maxConcurrent) {
      return { allowed: false, reason: 'concurrency', remaining: this.remaining ?? 0 };
    }
    if (this.dailyLimit !== null && this.state.used >= this.dailyLimit) {
      return { allowed: false, reason: 'daily_quota', remaining: 0 };
    }

    this.inFlight += 1;
    this.state.used += 1;
    this.store.write(this.state);
    return { allowed: true, remaining: this.remaining };
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  refund(): void {
    this.rollOver();
    if (this.state.used > 0) {
      this.state.used -= 1;
      this.store.write(this.state);
    }
  }
}
