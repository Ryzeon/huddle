/**
 * Cubeta de tokens.
 *
 * Función pura sobre un estado explícito: sin relojes globales ni `Date.now()`
 * escondido, para que los tests puedan mover el tiempo a mano.
 */

export interface TokenBucket {
  tokens: number;
  /** Epoch ms del último recálculo. */
  updatedAt: number;
}

export interface BucketPolicy {
  /** Cuántas operaciones seguidas se toleran. */
  readonly burst: number;
  /** Cada cuánto se repone un token, en ms. */
  readonly refillMs: number;
}

export function newBucket(policy: BucketPolicy, now: number): TokenBucket {
  return { tokens: policy.burst, updatedAt: now };
}

/**
 * Repone según el tiempo transcurrido y consume un token.
 * Devuelve el estado nuevo y si la operación se permite.
 *
 * No muta la entrada: devolver un valor nuevo hace imposible el bug de dejar
 * la cubeta a medio actualizar cuando la operación se rechaza.
 */
export function consume(
  bucket: TokenBucket,
  policy: BucketPolicy,
  now: number,
): { bucket: TokenBucket; allowed: boolean } {
  let { tokens, updatedAt } = bucket;

  const elapsed = now - updatedAt;
  if (elapsed >= policy.refillMs) {
    const refilled = Math.floor(elapsed / policy.refillMs);
    tokens = Math.min(policy.burst, tokens + refilled);
    updatedAt += refilled * policy.refillMs;
  }

  if (tokens <= 0) return { bucket: { tokens, updatedAt }, allowed: false };
  return { bucket: { tokens: tokens - 1, updatedAt }, allowed: true };
}
