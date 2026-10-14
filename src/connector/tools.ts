import { getProductService, searchProductsService } from '../products/product.service.js';
import { BadRequestError } from '../utils/errors.js';
import { LIMITS } from '../products/product.validation.js';

/**
 * AI tool layer.
 *
 * These definitions are what you hand to an agent (ChatGPT Actions, MCP, the
 * Anthropic tool-use API, ...). The handlers delegate straight to the product
 * service — no Shopify logic is duplicated here.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const SEARCH_PRODUCTS_TOOL: ToolDefinition = {
  name: 'search_products',
  description:
    'Search the live Shopify product catalog. Use this whenever a user asks to find, compare ' +
    'or recommend products based on attributes such as product type, price, color, size, ' +
    'availability or keywords. Never invent products. Only recommend products returned by this tool.',
  input_schema: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        maxLength: LIMITS.maxQueryLength,
        description:
          'Natural-language description of what the shopper wants, e.g. "black regular fit shirt".',
      },
      min_price: {
        type: 'number',
        minimum: 0,
        description: 'Lowest acceptable price, in the store currency.',
      },
      max_price: {
        type: 'number',
        minimum: 0,
        description: 'Highest acceptable price, in the store currency (the shopper budget).',
      },
      size: {
        type: 'string',
        maxLength: LIMITS.maxAttributeLength,
        description: 'Required size, e.g. "L", "Large", "XL". Only in-stock sizes are matched.',
      },
      color: {
        type: 'string',
        maxLength: LIMITS.maxAttributeLength,
        description: 'Required color, e.g. "black".',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: LIMITS.maxLimit,
        description: `How many products to return. Defaults to ${LIMITS.defaultLimit}.`,
      },
    },
  },
};

export const GET_PRODUCT_TOOL: ToolDefinition = {
  name: 'get_product',
  description:
    'Retrieve detailed information about a specific Shopify product returned by search_products.',
  input_schema: {
    type: 'object',
    required: ['product_id'],
    additionalProperties: false,
    properties: {
      product_id: {
        type: 'string',
        description:
          'The product id exactly as returned by search_products, e.g. "gid://shopify/Product/123".',
      },
    },
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [SEARCH_PRODUCTS_TOOL, GET_PRODUCT_TOOL];

export type ToolName = 'search_products' | 'get_product';

export interface ToolDependencies {
  search?: typeof searchProductsService;
  getProduct?: typeof getProductService;
}

/** Dispatches a tool call. Input validation happens inside the product service. */
export async function callTool(
  name: string,
  args: unknown,
  deps: ToolDependencies = {},
): Promise<unknown> {
  const search = deps.search ?? searchProductsService;
  const getProduct = deps.getProduct ?? getProductService;

  switch (name) {
    case 'search_products': {
      const { products, total } = await search(args);
      return { products, total };
    }
    case 'get_product': {
      const input = (args ?? {}) as Record<string, unknown>;
      return getProduct(input.product_id);
    }
    default:
      throw new BadRequestError(
        `Unknown tool "${name}". Available tools: ${TOOL_DEFINITIONS.map((t) => t.name).join(', ')}.`,
      );
  }
}
