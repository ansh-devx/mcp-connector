/**
 * Application errors carry an HTTP status and a stable machine-readable code.
 * Messages here are safe to return to clients: never put secrets in them.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid API key.') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

/** Any failure talking to Shopify: network, GraphQL, throttling, auth. */
export class ShopifyApiError extends AppError {
  constructor(message: string, statusCode = 502, details?: unknown) {
    super(statusCode, 'SHOPIFY_API_ERROR', message, details);
    this.name = 'ShopifyApiError';
  }
}

/**
 * Defence in depth: strip anything token-shaped out of text that may reach a
 * log or an HTTP response. Shopify tokens are `shpat_`/`shpca_`/`shppa_` +  hex.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/shp(at|ca|pa|ss)_[A-Za-z0-9]+/g, 'shp***_[REDACTED]')
    .replace(/(X-Shopify-Access-Token"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/g, '$1[REDACTED]');
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
