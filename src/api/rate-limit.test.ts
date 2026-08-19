import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Hono } from 'hono';

import {
  clientKey,
  FixedWindowCounter,
  rateLimit,
  ruleFromEnv,
  type RateLimitRule,
} from './rate-limit.js';

const rule: RateLimitRule = { windowMs: 60_000, max: 2 };

afterEach(() => {
  delete process.env.RATE_LIMIT_ENABLED;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
  delete process.env.CUSTOM_LIMIT_WINDOW_MS;
  delete process.env.TRUST_PROXY;
});

function limitedApp(path: string, r: RateLimitRule | (() => RateLimitRule) = rule): Hono {
  const app = new Hono();
  app.use(path, rateLimit(r));
  app.get(path, c => c.text('ok'));
  return app;
}

describe('rate limit middleware', () => {
  it('allows the first two requests and rejects the third with headers', async () => {
    const app = limitedApp('/three');

    assert.equal((await app.request('/three')).status, 200);
    assert.equal((await app.request('/three')).status, 200);

    const denied = await app.request('/three');
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), { error: 'Too many requests' });
    const retryAfter = Number(denied.headers.get('Retry-After'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
    assert.equal(denied.headers.get('RateLimit-Remaining'), '0');
  });

  it('sets RateLimit-Limit and a decreasing RateLimit-Remaining on success', async () => {
    const app = limitedApp('/decreasing', { windowMs: 60_000, max: 3 });

    const first = await app.request('/decreasing');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('RateLimit-Limit'), '3');
    assert.equal(first.headers.get('RateLimit-Remaining'), '2');

    assert.equal((await app.request('/decreasing')).headers.get('RateLimit-Remaining'), '1');

    const third = await app.request('/decreasing');
    assert.equal(third.status, 200);
    assert.equal(third.headers.get('RateLimit-Remaining'), '0');
  });

  it('is bypassed when RATE_LIMIT_ENABLED=false', async () => {
    process.env.RATE_LIMIT_ENABLED = 'false';
    const app = limitedApp('/disabled');

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/disabled');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('RateLimit-Limit'), null);
      assert.equal(res.headers.get('RateLimit-Remaining'), null);
      assert.equal(res.headers.get('RateLimit-Reset'), null);
    }
  });

  it('is bypassed when the rule max is zero or negative', async () => {
    for (const max of [0, -1]) {
      const app = limitedApp('/maxless', { windowMs: 60_000, max });
      const res = await app.request('/maxless');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('RateLimit-Remaining'), null);
    }
  });

  it('does not share buckets across route paths for the same client', async () => {
    const app = new Hono();
    app.use('/one', rateLimit(rule));
    app.get('/one', c => c.text('ok'));
    app.use('/two', rateLimit(rule));
    app.get('/two', c => c.text('ok'));

    assert.equal((await app.request('/one')).status, 200);
    assert.equal((await app.request('/one')).status, 200);
    // `/one` is exhausted; `/two` is a separate bucket.
    assert.equal((await app.request('/two')).status, 200);
    assert.equal((await app.request('/one')).status, 429);
  });

  it('evaluates a rule function per request so env changes take effect', async () => {
    const app = limitedApp('/live', () => ({
      max: Number(process.env.LIVE_MAX ?? 1),
      windowMs: 60_000,
    }));

    process.env.LIVE_MAX = '1';
    assert.equal((await app.request('/live')).status, 200);
    assert.equal((await app.request('/live')).status, 429);

    process.env.LIVE_MAX = '5';
    assert.equal((await app.request('/live')).status, 200);
    delete process.env.LIVE_MAX;
  });
});

describe('FixedWindowCounter', () => {
  it('rolls the window over once resetAt passes', () => {
    const counter = new FixedWindowCounter();
    const t0 = 1_000;

    assert.equal(counter.hit('k', rule, t0).allowed, true);
    assert.equal(counter.hit('k', rule, t0).allowed, true);
    assert.equal(counter.hit('k', rule, t0).allowed, false);
    assert.equal(counter.hit('k', rule, t0).remaining, 0);

    const afterReset = counter.hit('k', rule, t0 + 60_001);
    assert.equal(afterReset.allowed, true);
    assert.equal(afterReset.remaining, 1);
  });

  it('caps the number of tracked keys and sweeps expired entries', () => {
    const counter = new FixedWindowCounter(10);
    const t0 = 1_000;
    for (let i = 0; i < 100; i++) {
      counter.hit(`key-${i}`, rule, t0);
    }
    assert.ok(counter.size <= 10);

    // Advance past the window: inserting one new key sweeps all expired
    // entries instead of evicting the most recent ones.
    counter.hit('fresh', rule, t0 + 60_001);
    assert.equal(counter.size, 1);
  });
});

describe('ruleFromEnv', () => {
  it('reads env vars lazily and falls back on garbage input', () => {
    const rule = ruleFromEnv('RATE_LIMIT_MAX', 3);

    process.env.RATE_LIMIT_MAX = '7';
    assert.equal(rule().max, 7);

    process.env.RATE_LIMIT_MAX = 'not-a-number';
    assert.equal(rule().max, 3);
    process.env.RATE_LIMIT_MAX = '-5';
    assert.equal(rule().max, 3);
    process.env.RATE_LIMIT_MAX = 'Infinity';
    assert.equal(rule().max, 3);
    delete process.env.RATE_LIMIT_MAX;
    assert.equal(rule().max, 3);
  });

  it('defaults the window to RATE_LIMIT_WINDOW_MS / 60s and honors a custom var', () => {
    const rule = ruleFromEnv('RATE_LIMIT_MAX', 3);
    assert.equal(rule().windowMs, 60_000);

    process.env.RATE_LIMIT_WINDOW_MS = '5000';
    assert.equal(rule().windowMs, 5000);
    process.env.RATE_LIMIT_WINDOW_MS = 'abc';
    assert.equal(rule().windowMs, 60_000);
    delete process.env.RATE_LIMIT_WINDOW_MS;

    const customWindow = ruleFromEnv('RATE_LIMIT_MAX', 3, 'CUSTOM_LIMIT_WINDOW_MS', 42);
    process.env.CUSTOM_LIMIT_WINDOW_MS = '123';
    assert.equal(customWindow().windowMs, 123);
    process.env.CUSTOM_LIMIT_WINDOW_MS = '-1';
    assert.equal(customWindow().windowMs, 42);
  });
});

describe('clientKey', () => {
  async function keyFor(headers: Record<string, string> = {}): Promise<string> {
    const app = new Hono();
    app.get('/key', c => c.json({ key: clientKey(c) }));
    const res = await app.request('/key', { headers });
    return (await res.json()).key;
  }

  it('falls back to a shared unknown bucket without a socket peer', async () => {
    assert.equal(await keyFor(), 'unknown');
  });

  it('ignores proxy headers unless TRUST_PROXY=true', async () => {
    assert.equal(await keyFor({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), 'unknown');
  });

  it('trusts the first x-forwarded-for hop when TRUST_PROXY=true', async () => {
    process.env.TRUST_PROXY = 'true';
    assert.equal(await keyFor({ 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8 ' }), '1.2.3.4');
  });

  it('falls back to x-real-ip when TRUST_PROXY=true and no x-forwarded-for is set', async () => {
    process.env.TRUST_PROXY = 'true';
    assert.equal(await keyFor({ 'x-real-ip': '10.0.0.1' }), '10.0.0.1');
  });

  it('normalizes IPv4-mapped IPv6 addresses', async () => {
    process.env.TRUST_PROXY = 'true';
    assert.equal(await keyFor({ 'x-forwarded-for': '::ffff:1.2.3.4' }), '1.2.3.4');
  });
});
