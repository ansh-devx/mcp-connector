import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '../config/index.js';
import { RateLimiter } from './rate-limit.js';

/**
 * Fastify guard that throttles the endpoints which reach Shopify.
 *
 * Shopify's Admin API is cost-based rate limited, so an unthrottled caller can
 * exhaust the store's budget and get the *storefront* throttled too — the blast
 * radius is wider than this service.
 */

/** Cheap or operational routes: never throttled. */
const EXEMPT_PATHS = new Set(['/health', '/', '/openapi.json', '/connector/tools']);

let limiter: RateLimiter | null = null;

function getLimiter(): RateLimiter | null {
  const { rateLimit } = getConfig();
  if (rateLimit.max <= 0) return null; // disabled
  if (limiter === null) {
    limiter = new RateLimiter({
      capacity: rateLimit.max,
      refillPerSecond: rateLimit.max / rateLimit.windowSeconds,
    });
  }
  return limiter;
}

/** Test helper: drops bucket state and re-reads config on the next request. */
export function resetRateLimiter(): void {
  limiter = null;
}

/**
 * Who to count against. `request.ip` already honours X-Forwarded-For because the
 * app sets `trustProxy`, which is what makes this meaningful behind Cloud Run.
 *
 * Caveat worth knowing: callers behind one NAT or one Google egress range share
 * a bucket. This bounds abuse; it is not per-user fairness.
 */
function clientKey(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

export async function rateLimitGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const active = getLimiter();
  if (active === null) return;

  const path = request.url.split('?')[0] ?? '';
  if (EXEMPT_PATHS.has(path)) return;

  const { rateLimit } = getConfig();
  const decision = active.consume(clientKey(request));

  reply.header('RateLimit-Limit', String(rateLimit.max));
  reply.header('RateLimit-Remaining', String(decision.remaining));
  reply.header('RateLimit-Reset', String(decision.resetSeconds));

  if (decision.allowed) return;

  reply.header('Retry-After', String(decision.retryAfterSeconds));
  request.log.warn(
    { path, retry_after: decision.retryAfterSeconds },
    'request rate limited',
  );

  const message =
    `Rate limit exceeded: at most ${rateLimit.max} requests per ` +
    `${rateLimit.windowSeconds}s. Retry in ${decision.retryAfterSeconds}s.`;

  // /mcp speaks JSON-RPC, so an HTTP-shaped body would be unparseable to an MCP
  // client. -32000 is the same server-error code its 405 handler uses.
  if (path === '/mcp') {
    return reply.status(429).send({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
  }

  return reply.status(429).send({
    error: { code: 'RATE_LIMITED', message },
  });
}
