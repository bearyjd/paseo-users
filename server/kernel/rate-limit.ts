import type { Clock } from "./clock.js";

export interface RateLimitPolicy {
  /** Failures within `windowMs` that trigger a lock. */
  maxFailures: number;
  windowMs: number;
  /** First lock duration; doubles on each repeated lock up to `maxLockMs`. */
  lockMs: number;
  maxLockMs: number;
}

export const DEFAULT_ACCOUNT_POLICY: RateLimitPolicy = {
  maxFailures: 8,
  windowMs: 15 * 60_000,
  lockMs: 60_000,
  maxLockMs: 15 * 60_000,
};
export const DEFAULT_ADDRESS_POLICY: RateLimitPolicy = {
  maxFailures: 30,
  windowMs: 15 * 60_000,
  lockMs: 60_000,
  maxLockMs: 60 * 60_000,
};

interface Entry {
  failures: number[];
  lockedUntil: number;
  lockCount: number;
}

/**
 * In-memory failure throttle keyed by an opaque string (account name, remote address).
 * Locks are temporary and capped, so an attacker who can reach the login endpoint can delay
 * a victim by at most `maxLockMs` per lock rather than locking the account out indefinitely.
 * State is intentionally not persisted: a restart clears locks, which fails open for the
 * attacker only as far as one restart's worth of attempts. Documented in the threat model.
 */
export class FailureThrottle {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly policy: RateLimitPolicy,
    private readonly clock: Clock,
    private readonly maxKeys = 10_000,
  ) {}

  /** Milliseconds until the key may try again, or 0. */
  retryAfterMs(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - this.clock.now().getTime());
  }

  recordFailure(key: string): void {
    const now = this.clock.now().getTime();
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) this.evict(now);
      entry = { failures: [], lockedUntil: 0, lockCount: 0 };
      this.entries.set(key, entry);
    }
    entry.failures = entry.failures.filter((at) => now - at < this.policy.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.policy.maxFailures && now >= entry.lockedUntil) {
      entry.lockCount++;
      const lock = Math.min(this.policy.lockMs * 2 ** (entry.lockCount - 1), this.policy.maxLockMs);
      entry.lockedUntil = now + lock;
      entry.failures = [];
    }
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Administrator unlock. */
  reset(key: string): void {
    this.entries.delete(key);
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && entry.failures.every((at) => now - at >= this.policy.windowMs)) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
