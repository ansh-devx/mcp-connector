import { BadRequestError } from '../utils/errors.js';
import type { ResolvedSearchParams } from './product.types.js';

/**
 * Service-level validation. Routes also declare JSON schemas, but the connector
 * calls the service directly, so the real guard has to live here.
 */

export const LIMITS = {
  defaultLimit: 5,
  maxLimit: 20,
  maxQueryLength: 200,
  maxAttributeLength: 40,
  maxPrice: 100_000_000,
} as const;

function asOptionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new BadRequestError(`"${field}" must be a number.`);
  }
  if (num < 0) throw new BadRequestError(`"${field}" must not be negative.`);
  if (num > LIMITS.maxPrice) {
    throw new BadRequestError(`"${field}" must be at most ${LIMITS.maxPrice}.`);
  }
  return num;
}

function asOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRequestError(`"${field}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > LIMITS.maxAttributeLength) {
    throw new BadRequestError(
      `"${field}" must be at most ${LIMITS.maxAttributeLength} characters.`,
    );
  }
  return trimmed;
}

/** Throws BadRequestError (HTTP 400) on any malformed input. */
export function validateSearchParams(input: unknown): ResolvedSearchParams {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestError('Request body must be a JSON object.');
  }
  const body = input as Record<string, unknown>;

  if (typeof body.query !== 'string' || body.query.trim() === '') {
    throw new BadRequestError('"query" is required and must be a non-empty string.');
  }
  const query = body.query.trim();
  if (query.length > LIMITS.maxQueryLength) {
    throw new BadRequestError(`"query" must be at most ${LIMITS.maxQueryLength} characters.`);
  }

  const minPrice = asOptionalNumber(body.min_price, 'min_price');
  const maxPrice = asOptionalNumber(body.max_price, 'max_price');
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    throw new BadRequestError('"min_price" must be less than or equal to "max_price".');
  }

  let limit: number = LIMITS.defaultLimit;
  if (body.limit !== undefined && body.limit !== null) {
    const raw = typeof body.limit === 'string' ? Number(body.limit) : body.limit;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      throw new BadRequestError('"limit" must be an integer.');
    }
    if (raw < 1 || raw > LIMITS.maxLimit) {
      throw new BadRequestError(`"limit" must be between 1 and ${LIMITS.maxLimit}.`);
    }
    limit = raw;
  }

  return {
    query,
    minPrice,
    maxPrice,
    size: asOptionalString(body.size, 'size'),
    color: asOptionalString(body.color, 'color'),
    limit,
  };
}

const NUMERIC_ID = /^\d+$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

/** Accepts a full product GID or a bare numeric id and returns a canonical GID. */
export function normalizeProductId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestError('Product id is required.');
  }
  // Fastify decodes the path param, but be tolerant of double-encoded input.
  let value = raw.trim();
  if (value.includes('%2F') || value.includes('%2f')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      throw new BadRequestError('Product id is not a valid URL-encoded value.');
    }
  }
  if (NUMERIC_ID.test(value)) return `gid://shopify/Product/${value}`;
  if (PRODUCT_GID.test(value)) return value;
  throw new BadRequestError(
    'Product id must be a Shopify product GID (gid://shopify/Product/123) or a numeric id.',
  );
}
