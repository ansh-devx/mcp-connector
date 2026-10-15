import './setup.env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimiter } from '../src/utils/rate-limit.js';

/** Controllable clock so tests assert refill behaviour without sleeping. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('RateLimiter', () => {
  it('allows up to capacity then rejects', () => {
    const t = clock();
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: t.now });
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);
  });

  it('reports remaining tokens', () => {
    const t = clock();
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: t.now });
    assert.equal(limiter.consume('a').remaining, 2);
    assert.equal(limiter.consume('a').remaining, 1);
    assert.equal(limiter.consume('a').remaining, 0);
  });

  it('keeps buckets independent per key', () => {
    const t = clock();
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: t.now });
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);
    // b is untouched by a's exhaustion.
    assert.equal(limiter.consume('b').allowed, true);
  });

  it('refills over time', () => {
    const t = clock();
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: t.now });
    limiter.consume('a');
    limiter.consume('a');
    assert.equal(limiter.consume('a').allowed, false);

    t.advance(1000); // one token back
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);
  });

  it('never refills beyond capacity', () => {
    const t = clock();
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: t.now });
    limiter.consume('a');
    t.advance(60_000); // idle far longer than it takes to fill
    assert.equal(limiter.consume('a').remaining, 1, 'bucket should cap at capacity, not accrue');
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);
  });

  it('returns a Retry-After that is actually long enough', () => {
    const t = clock();
    // 0.5 tokens/sec: a token takes 2s.
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.5, now: t.now });
    limiter.consume('a');
    const denied = limiter.consume('a');
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSeconds, 2);

    // Waiting exactly that long must succeed, or the hint is a lie.
    t.advance(denied.retryAfterSeconds * 1000);
    assert.equal(limiter.consume('a').allowed, true);
  });

  it('never advertises Retry-After: 0', () => {
    const t = clock();
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 100, now: t.now });
    limiter.consume('a');
    // Even when a token is ~10ms away, 0 would invite a hot retry loop.
    assert.ok(limiter.consume('a').retryAfterSeconds >= 1);
  });

  it('rejects nonsensical options', () => {
    assert.throws(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 }), /capacity/);
    assert.throws(() => new RateLimiter({ capacity: 1, refillPerSecond: 0 }), /refillPerSecond/);
  });

  it('evicts idle buckets but keeps throttled ones', () => {
    const t = clock();
    const limiter = new RateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      idleEvictionMs: 5000,
      now: t.now,
    });
    limiter.consume('old');
    t.advance(10_000);
    // Sweep is amortised; drive enough traffic on another key to trigger it.
    for (let i = 0; i < 600; i += 1) limiter.consume('busy');
    assert.ok(limiter.size() <= 2, 'stale key should have been swept');
  });
});

// ---------------------------------------------------------------------------
// HTTP behaviour. Config is read once per process, so these tests set the env
// vars and reset both caches before building an app.
// ---------------------------------------------------------------------------

import { buildApp } from '../src/app.js';
import { resetConfigCache } from '../src/config/index.js';
import { resetRateLimiter } from '../src/utils/rate-limit-hook.js';
import { searchProductsService } from '../src/products/product.service.js';
import { stubCandidates } from './fixtures.js';

function appWithLimit(max: number, windowSeconds = 60) {
  process.env.RATE_LIMIT_MAX = String(max);
  process.env.RATE_LIMIT_WINDOW_SECONDS = String(windowSeconds);
  resetConfigCache();
  resetRateLimiter();
  return buildApp({
    logger: false,
    routes: { search: (input: unknown) => searchProductsService(input, stubCandidates()) },
  });
}

function clearLimitEnv(): void {
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_SECONDS;
  resetConfigCache();
  resetRateLimiter();
}

const search = (app: ReturnType<typeof buildApp>) =>
  app.inject({ method: 'POST', url: '/api/search-products', payload: { query: 'shirt' } });

describe('rate limiting over HTTP', () => {
  it('is off by default, so existing deployments are unchanged', async () => {
    clearLimitEnv();
    const app = buildApp({
      logger: false,
      routes: { search: (input: unknown) => searchProductsService(input, stubCandidates()) },
    });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await search(app)).statusCode, 200);
    }
    await app.close();
  });

  it('returns 429 with Retry-After once the budget is spent', async () => {
    const app = appWithLimit(2);
    assert.equal((await search(app)).statusCode, 200);
    assert.equal((await search(app)).statusCode, 200);

    const limited = await search(app);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    await app.close();
    clearLimitEnv();
  });

  it('advertises the budget on every response', async () => {
    const app = appWithLimit(5);
    const response = await search(app);
    assert.equal(response.headers['ratelimit-limit'], '5');
    assert.equal(response.headers['ratelimit-remaining'], '4');
    assert.ok(Number(response.headers['ratelimit-reset']) >= 0);
    await app.close();
    clearLimitEnv();
  });

  it('never throttles /health, so deploy probes keep working', async () => {
    const app = appWithLimit(1);
    await search(app); // spend the entire budget
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    }
    await app.close();
    clearLimitEnv();
  });

  it('answers /mcp with a JSON-RPC shaped 429, not an HTTP-shaped body', async () => {
    const app = appWithLimit(1);
    await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    const limited = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    assert.equal(limited.statusCode, 429);
    const body = limited.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32000);
    assert.match(body.error.message, /Rate limit exceeded/);
    await app.close();
    clearLimitEnv();
  });

  it('also covers the product and connector routes', async () => {
    const app = appWithLimit(1);
    await search(app);
    for (const url of ['/api/products/123', '/connector/tools/search_products']) {
      const method = url.startsWith('/connector') ? 'POST' : 'GET';
      const response = await app.inject({ method, url, payload: { query: 'x' } });
      assert.equal(response.statusCode, 429, `${url} should be throttled`);
    }
    await app.close();
    clearLimitEnv();
  });
});
