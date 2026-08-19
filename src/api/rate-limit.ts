import type { Context, MiddlewareHandler } from 'hono';

export type RateLimitRule = { windowMs: number; max: number };

// ── Client key ─────────────────────────────────────────────────────────────────

/**
 * Shape of the bindings injected by `@hono/node-server`. Hono's default `Env`
 * generic is empty, so the request socket is reached through a local interface
 * (plus a cast) instead of falling back to `any`.
 */
interface NodeServerEnv {
  incoming?: {
    socket?: {
      remoteAddress?: unknown;
    };
  };
}

/** Collapse IPv4-mapped IPv6 (`::ffff:1.2.3.4`) and normalize case. */
function normalizeAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  return normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
}

/**
 * Derive the rate-limit bucket key for a request.
 *
 * Proxy headers are only trusted when `TRUST_PROXY === 'true'` — otherwise a
 * spoofed `x-forwarded-for` would let an attacker mint unlimited buckets. When
 * trusted, the first hop of `x-forwarded-for` is used, falling back to
 * `x-real-ip`. Without a peer address the shared literal `'unknown'` is used so
 * such traffic shares one bucket instead of bypassing the limiter.
 */
export function clientKey(c: Context): string {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return normalizeAddress(forwarded);
    const realIp = c.req.header('x-real-ip')?.trim();
    if (realIp) return normalizeAddress(realIp);
  }
  const env = c.env as NodeServerEnv | undefined;
  const remoteAddress = env?.incoming?.socket?.remoteAddress;
  const peer = typeof remoteAddress === 'string' ? remoteAddress : '';
  return normalizeAddress(peer || 'unknown');
}

// ── Fixed-window counter ───────────────────────────────────────────────────────

type WindowEntry = { count: number; resetAt: number };

/** Sweep expired entries at most once per this many new-key inserts. */
const SWEEP_EVERY_INSERTS = 1024;

/**
 * In-process fixed-window counter with a bounded key map, so a flood of
 * distinct keys cannot grow memory without limit.
 */
export class FixedWindowCounter {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly maxKeys: number;
  private insertsSinceSweep = 0;

  constructor(maxKeys = 20_000) {
    this.maxKeys = Math.max(1, maxKeys);
  }

  get size(): number {
    return this.entries.size;
  }

  hit(
    key: string,
    rule: RateLimitRule,
    now: number = Date.now(),
  ): { allowed: boolean; remaining: number; resetAt: number } {
    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      if (!entry) {
        this.makeRoom(now);
      }
      entry = { count: 0, resetAt: now + rule.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    const allowed = entry.count <= rule.max;
    return { allowed, remaining: Math.max(0, rule.max - entry.count), resetAt: entry.resetAt };
  }

  /**
   * Free capacity for a new key. Expired entries are swept first, amortized to
   * only run when at capacity or every `SWEEP_EVERY_INSERTS` inserts; if that
   * frees nothing, oldest-inserted keys are evicted (a `Map` iterates in
   * insertion order) until under the cap.
   */
  private makeRoom(now: number): void {
    this.insertsSinceSweep += 1;
    if (this.entries.size < this.maxKeys && this.insertsSinceSweep < SWEEP_EVERY_INSERTS) {
      return;
    }
    this.insertsSinceSweep = 0;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/** Shared across every route so memory stays bounded per process. */
const sharedCounter = new FixedWindowCounter();

function routePathOf(c: Context): string {
  try {
    return c.req.routePath || new URL(c.req.url).pathname;
  } catch {
    return new URL(c.req.url).pathname;
  }
}

/**
 * Fixed-window rate limiting middleware. The `rule` may be a literal or a
 * zero-arg function evaluated per request, so env-derived limits stay live.
 */
export function rateLimit(rule: RateLimitRule | (() => RateLimitRule)): MiddlewareHandler {
  return async (c, next) => {
    if (process.env.RATE_LIMIT_ENABLED === 'false') {
      await next();
      return;
    }
    const effectiveRule = typeof rule === 'function' ? rule() : rule;
    if (effectiveRule.max <= 0) {
      await next();
      return;
    }
    // Namespace by route so different limits do not share a bucket.
    const key = `${clientKey(c)}|${c.req.method}|${routePathOf(c)}`;
    const now = Date.now();
    const { allowed, remaining, resetAt } = sharedCounter.hit(key, effectiveRule, now);
    const resetSeconds = Math.max(0, Math.ceil((resetAt - now) / 1000));

    c.header('RateLimit-Limit', String(effectiveRule.max));
    c.header('RateLimit-Remaining', String(remaining));
    c.header('RateLimit-Reset', String(resetSeconds));

    if (!allowed) {
      c.header('Retry-After', String(Math.ceil((resetAt - now) / 1000)));
      return c.json({ error: 'Too many requests' }, 429);
    }
    await next();
  };
}

// ── Env-derived rules ──────────────────────────────────────────────────────────

/** Read a non-negative finite number from the environment; fall back on absent or garbage. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Build a lazy per-route rule from the environment. `windowVar` defaults to
 * `RATE_LIMIT_WINDOW_MS` with a 60000 ms default; non-finite/negative env
 * values fall back to the defaults.
 */
export function ruleFromEnv(
  maxVar: string,
  defaultMax: number,
  windowVar?: string,
  defaultWindowMs?: number,
): () => RateLimitRule {
  return () => ({
    max: envNumber(maxVar, defaultMax),
    windowMs: envNumber(windowVar ?? 'RATE_LIMIT_WINDOW_MS', defaultWindowMs ?? 60_000),
  });
}
