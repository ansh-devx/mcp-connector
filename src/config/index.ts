import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Absolute path to the `.env` that ships beside this package.
 *
 * Resolved from this module's own location rather than the working directory,
 * because an MCP client spawns the stdio server from wherever it likes —
 * Claude Desktop uses `/` — and a cwd-relative lookup silently finds nothing.
 * `src/config/` and `dist/config/` are both two levels below the package root.
 */
export const PACKAGE_ENV_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.env',
);

// Order matters, and dotenv never overrides a value that is already set:
// real environment variables win, then a .env in the working directory
// (unchanged behaviour), then the package's own .env as the fallback.
loadDotenv();
loadDotenv({ path: PACKAGE_ENV_PATH });

export interface AppConfig {
  readonly shopify: {
    /** Bare myshopify domain, e.g. `example.myshopify.com`. */
    readonly storeDomain: string;
    readonly accessToken: string;
    readonly apiVersion: string;
    /** Public storefront origin used to build product URLs. */
    readonly storefrontUrl: string;
  };
  readonly server: {
    readonly port: number;
    readonly host: string;
    readonly logLevel: string;
  };
  /** When null, API-key auth is disabled (local development). */
  readonly connectorApiKey: string | null;
  readonly nodeEnv: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Accepts `https://shop.myshopify.com/` and returns `shop.myshopify.com`. */
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function readEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, received "${raw}"`);
  }
  return port;
}

function buildConfig(): AppConfig {
  const missing: string[] = [];

  // Supports both the documented names and the shorter aliases.
  const storeDomain = readEnv(['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_STORE']);
  if (!storeDomain) missing.push('SHOPIFY_STORE_DOMAIN');

  const accessToken = readEnv(['SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_ACCESS_TOKEN']);
  if (!accessToken) missing.push('SHOPIFY_ADMIN_ACCESS_TOKEN');

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in the values.',
    );
  }

  const domain = normalizeDomain(storeDomain as string);
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) {
    throw new ConfigError(
      `SHOPIFY_STORE_DOMAIN must look like "your-store.myshopify.com", received "${domain}"`,
    );
  }

  const apiVersion = readEnv(['SHOPIFY_API_VERSION']) ?? '2026-07';
  if (!/^\d{4}-\d{2}$/.test(apiVersion) && apiVersion !== 'unstable') {
    throw new ConfigError(
      `SHOPIFY_API_VERSION must look like "2026-07", received "${apiVersion}"`,
    );
  }

  const storefrontUrl = (readEnv(['SHOPIFY_STOREFRONT_URL']) ?? `https://${domain}`).replace(
    /\/+$/,
    '',
  );

  return {
    shopify: {
      storeDomain: domain,
      accessToken: accessToken as string,
      apiVersion,
      storefrontUrl,
    },
    server: {
      port: readPort(readEnv(['PORT']), 3000),
      host: readEnv(['HOST']) ?? '0.0.0.0',
      logLevel: readEnv(['LOG_LEVEL']) ?? 'info',
    },
    connectorApiKey: readEnv(['CONNECTOR_API_KEY']) ?? null,
    nodeEnv: readEnv(['NODE_ENV']) ?? 'development',
  };
}

let cached: AppConfig | null = null;

/** Lazily built and memoised so importing a module never throws on a missing env var. */
export function getConfig(): AppConfig {
  if (cached === null) cached = buildConfig();
  return cached;
}

/** Test helper: forces the next getConfig() call to re-read process.env. */
export function resetConfigCache(): void {
  cached = null;
}
