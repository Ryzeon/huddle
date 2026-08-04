/**
 * Cubeta de tokens.
 *
 * Función pura sobre un estado explícito: sin relojes globales ni `Date.now()`
 * escondido, para que los tests puedan mover el tiempo a mano.
 */

export interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

export interface BucketPolicy {
  readonly burst: number;
  readonly refillMs: number;
}

export function newBucket(policy: BucketPolicy, now: number): TokenBucket {
  return { tokens: policy.burst, updatedAt: now };
}

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
