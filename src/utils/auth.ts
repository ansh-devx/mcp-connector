import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '../config/index.js';
import { UnauthorizedError } from './errors.js';

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Paths that never require an API key. */
const PUBLIC_PATHS = new Set(['/health', '/', '/openapi.json']);

/**
 * Bearer-token guard. Disabled entirely when CONNECTOR_API_KEY is unset,
 * which keeps local development friction-free.
 */
export async function apiKeyGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const expected = getConfig().connectorApiKey;
  if (expected === null) return;

  const path = request.url.split('?')[0] ?? '';
  if (PUBLIC_PATHS.has(path)) return;

  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing "Authorization: Bearer <token>" header.');
  }
  if (!safeEqual(header.slice('Bearer '.length).trim(), expected)) {
    throw new UnauthorizedError('Invalid API key.');
  }
}
