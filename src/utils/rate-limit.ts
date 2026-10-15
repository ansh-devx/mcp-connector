/**
 * In-process token-bucket rate limiter.
 *
 * A token bucket rather than a fixed window: a fixed window lets a caller fire
 * the whole quota at 59.9s and again at 60.1s, so the real burst is double the
 * configured limit. A bucket refills continuously, so the long-run rate and the
 * burst ceiling are both exactly what you configured.
 *
 * State is per-process. On Cloud Run with N warm instances the effective global
 * limit is N x `capacity`, which is fine for bounding abuse but is not a quota
 * system — that would need shared storage (Redis) and is not worth it here.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left after this request; 0 when rejected. */
  remaining: number;
  /** Whole seconds until at least one token is available. 0 when allowed. */
  retryAfterSeconds: number;
  /** Whole seconds until the bucket is full again — the `RateLimit-Reset` value. */
  resetSeconds: number;
}

export interface RateLimiterOptions {
  /** Bucket size: the largest burst a single key may make. */
  capacity: number;
  /** Tokens added per second. `capacity / windowSeconds` gives a classic "N per window". */
  refillPerSecond: number;
  /** Buckets untouched for this long are swept, so memory cannot grow without bound. */
  idleEvictionMs?: number;
  /** Injected in tests so time can be controlled instead of slept through. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_IDLE_EVICTION_MS = 10 * 60 * 1000;
/** Sweeping on every request would be O(keys) per call; amortise it. */
const SWEEP_EVERY_N_REQUESTS = 500;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly idleEvictionMs: number;
  private readonly now: () => number;
  private requestsSinceSweep = 0;

  constructor(options: RateLimiterOptions) {
    if (options.capacity <= 0) throw new Error('capacity must be greater than 0');
    if (options.refillPerSecond <= 0) throw new Error('refillPerSecond must be greater than 0');
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.idleEvictionMs = options.idleEvictionMs ?? DEFAULT_IDLE_EVICTION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Takes one token for `key`. Call exactly once per request. */
  consume(key: string): RateLimitDecision {
    const now = this.now();
    this.maybeSweep(now);

    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };

    // Refill for the time elapsed since this key was last seen.
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAt = now;

    let decision: RateLimitDecision;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      decision = {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: 0,
        resetSeconds: this.secondsUntilFull(bucket.tokens),
      };
    } else {
      const secondsToOneToken = (1 - bucket.tokens) / this.refillPerSecond;
      decision = {
        allowed: false,
        remaining: 0,
        // Always at least 1: a Retry-After of 0 invites an immediate retry.
        retryAfterSeconds: Math.max(1, Math.ceil(secondsToOneToken)),
        resetSeconds: this.secondsUntilFull(bucket.tokens),
      };
    }

    this.buckets.set(key, bucket);
    return decision;
  }

  /** Test/diagnostic helper: how many keys are currently tracked. */
  size(): number {
    return this.buckets.size;
  }

  private secondsUntilFull(tokens: number): number {
    return Math.ceil((this.capacity - tokens) / this.refillPerSecond);
  }

  private maybeSweep(now: number): void {
    if (++this.requestsSinceSweep < SWEEP_EVERY_N_REQUESTS) return;
    this.requestsSinceSweep = 0;
    for (const [key, bucket] of this.buckets) {
      // Only drop keys that have fully refilled: an evicted bucket resets to
      // full, so evicting a throttled key early would hand back its quota.
      if (now - bucket.updatedAt > this.idleEvictionMs) this.buckets.delete(key);
    }
  }
}
