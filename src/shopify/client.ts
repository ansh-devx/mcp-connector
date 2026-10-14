import { createAdminApiClient } from '@shopify/admin-api-client';
import { getConfig } from '../config/index.js';
import { ShopifyApiError, redactSecrets } from '../utils/errors.js';

type AdminClient = ReturnType<typeof createAdminApiClient>;

let client: AdminClient | null = null;

/** Lazily created so importing this module never requires env vars to be present. */
export function getShopifyClient(): AdminClient {
  if (client === null) {
    const { shopify } = getConfig();
    client = createAdminApiClient({
      storeDomain: shopify.storeDomain,
      apiVersion: shopify.apiVersion,
      accessToken: shopify.accessToken,
      retries: 2,
    });
  }
  return client;
}

/** Test helper. */
export function resetShopifyClient(): void {
  client = null;
}

interface GraphQlError {
  message?: string;
  extensions?: { code?: string };
}

function summarize(errors: GraphQlError[]): string {
  const messages = errors
    .map((e) => e.message)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
  return messages.length > 0 ? redactSecrets(messages.join('; ')) : 'Unknown GraphQL error';
}

/**
 * Runs a GraphQL operation and normalises every Shopify failure mode
 * (network, HTTP, GraphQL, throttling, auth) into a ShopifyApiError.
 */
export async function shopifyRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let response: Awaited<ReturnType<AdminClient['request']>>;

  try {
    response = await getShopifyClient().request(query, variables ? { variables } : undefined);
  } catch (cause) {
    // Thrown for DNS failures, timeouts, aborted sockets, etc.
    const message = cause instanceof Error ? redactSecrets(cause.message) : 'Unknown network error';
    throw new ShopifyApiError(`Could not reach the Shopify Admin API: ${message}`, 503);
  }

  const errors = response.errors;
  if (errors) {
    const graphQlErrors = (errors.graphQLErrors ?? []) as GraphQlError[];
    const networkStatus = errors.networkStatusCode;
    const detail = graphQlErrors.length > 0 ? summarize(graphQlErrors) : (errors.message ?? '');
    const codes = graphQlErrors.map((e) => e.extensions?.code).filter(Boolean);

    if (networkStatus === 401 || networkStatus === 403 || codes.includes('ACCESS_DENIED')) {
      // Deliberately vague: do not hint at token contents.
      throw new ShopifyApiError(
        'Shopify rejected the Admin API credentials or the app is missing a required scope ' +
          '(read_products / read_inventory).',
        502,
      );
    }
    if (networkStatus === 429 || codes.includes('THROTTLED')) {
      throw new ShopifyApiError('Shopify rate limit reached, please retry shortly.', 503);
    }
    if (networkStatus !== undefined && networkStatus >= 500) {
      throw new ShopifyApiError('Shopify is currently unavailable, please retry shortly.', 503);
    }
    if (networkStatus === undefined && graphQlErrors.length === 0) {
      // No HTTP status and no GraphQL payload: the request never completed
      // (DNS, TLS, timeout, retries exhausted). Retryable, so 503.
      throw new ShopifyApiError(
        `Could not reach the Shopify Admin API: ${redactSecrets(detail || 'network error')}`,
        503,
      );
    }
    throw new ShopifyApiError(
      `Shopify GraphQL request failed: ${redactSecrets(detail || 'unspecified error')}`,
      502,
    );
  }

  if (!response.data) {
    throw new ShopifyApiError('Shopify returned an empty response body.', 502);
  }

  return response.data as T;
}
