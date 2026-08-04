/**
 * Caché de preguntas ya respondidas.
 *
 * Bajo suscripción esto no es una optimización de latencia: es presupuesto.
 * Cada acierto es una pregunta que no le cuesta cuota a nadie y que devuelve
 * en milisegundos en vez de en un minuto.
 *
 * v0 usa similitud léxica (Jaccard sobre tokens). Es tosco pero honesto y sin
 * dependencias; embeddings en v1, cuando haya tráfico real que justifique el
 * coste de mantener un índice vectorial.
 */

import type { SourceRef } from '@huddle/protocol';

export interface CachedAnswer {
  question: string;
  answer: string;
  sources: SourceRef[];
  confidence: 'low' | 'medium' | 'high';
  /** SHA del repo cuando se produjo. Si el repo derivó, la entrada caduca. */
  sha?: string;
  branch?: string;
  at: number;
}

import type { CacheStorePort } from '../application/ports/index.js';

export type CacheStore = CacheStorePort;

export interface CacheDeps {
  store: CacheStore;
  now?: () => number;
}

/** Por debajo de esto, dos preguntas no son la misma pregunta. */
const SIMILARITY_THRESHOLD = 0.72;
const MAX_ENTRIES = 500;

export class QuestionCache {
  private readonly store: CacheStore;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private entries: CachedAnswer[];

  constructor(ttlHours: number, deps: CacheDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.entries = this.store.read();
  }

  /**
   * Busca una respuesta reutilizable.
   *
   * `currentSha` es deliberadamente estricto: si el repo se movió desde que se
   * cacheó, preferimos volver a preguntar antes que servir algo desactualizado
   * con cara de fresco. Es el mismo motivo por el que cada respuesta lleva SHA.
   */
  lookup(question: string, currentSha?: string): CachedAnswer | null {
    const cutoff = this.now() - this.ttlMs;
    const wanted = tokenSet(question);
    if (wanted.size === 0) return null;

    let best: CachedAnswer | null = null;
    let bestScore = 0;

    for (const entry of this.entries) {
      if (entry.at < cutoff) continue;
      if (currentSha && entry.sha && entry.sha !== currentSha) continue;

      const score = jaccard(wanted, tokenSet(entry.question));
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }

    return bestScore >= SIMILARITY_THRESHOLD ? best : null;
  }

  put(entry: Omit<CachedAnswer, 'at'>): void {
    this.entries.push({ ...entry, at: this.now() });
    this.prune();
    this.store.write(this.entries);
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
  }

  get size(): number {
    return this.entries.length;
  }
}

const STOPWORDS = new Set([
  'que', 'como', 'donde', 'cual', 'esta', 'este', 'para', 'por', 'con', 'los',
  'las', 'del', 'una', 'the', 'and', 'for', 'how', 'what', 'where', 'does',
  'why', 'when', 'who', 'esto', 'eso', 'hay', 'son', 'esa', 'ese',
]);

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}
