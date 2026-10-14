# Shopify AI Shopping Connector

A small, typed backend that lets an AI agent search a **live Shopify catalog**
using natural-language shopping requirements such as:

* "Find me a black shirt under ₹2,000"
* "Show me 3 shirts under ₹2,500"
* "Find a black regular-fit shirt available in L"
* "I need something casual for a dinner under ₹3,000"

It speaks three protocols over one implementation:

* **MCP** (Model Context Protocol) over stdio and Streamable HTTP — plug it straight
  into Claude Desktop, Claude Code, or any MCP client.
* **REST** — `POST /api/search-products`, `GET /api/products/:id`.
* **OpenAPI** — import `GET /openapi.json` as a ChatGPT Action.

All three expose the same two tools, `search_products` and `get_product`, and run
through the same product service. There is one implementation of the shopping
logic, not three.

## What it does

1. Translates the shopper's phrase into **Shopify product-search syntax** and asks
   the Shopify Admin GraphQL API for a pool of candidates.
2. Applies the shopper's **hard constraints locally** — price, size, colour and
   availability — because Shopify search alone cannot express them reliably.
3. **Ranks** the survivors with a deterministic relevance score (no embeddings,
   no LLM, no vector database).
4. Returns a compact product shape with storefront URLs and variant-level detail,
   so the agent can answer follow-ups like *"do you have this in XL?"*.

Notable behaviours:

* **Two-pass search.** Terms are ANDed first (precision). If that does not fill the
  page, the search widens to an OR pass (recall) and results are merged and
  de-duplicated. This is what makes *"something casual for a dinner"* return results
  rather than nothing.
* **Only buyable products.** A product with no in-stock variant is never returned.
* **Size *and* colour must hold on the same variant.** A shirt that comes in black
  and comes in L, but has no *black L* in stock, is correctly excluded.
* **Prices reflect what you can actually buy.** `price` is the lowest price among the
  *available* variants **that match the requested size and colour**. Ask for a black L
  and you are quoted the black L price — not some cheaper variant in another colour you
  cannot have. The budget filter uses the same rule, so a product whose matching variant
  is over budget is excluded even when an unrelated variant is cheap.
* **A t-shirt never silently stands in for a shirt.** `normalize("T-Shirt")` tokenizes to
  `["t", "shirt"]`, so plain term matching scores a t-shirt exactly like a real shirt.
  Products are classified by category instead, exact matches outrank substitutes, and
  every result carries `category_match: "exact" | "related"` so the agent can say
  *"no shirts under ₹2,500 — here are t-shirts"* rather than quietly swapping them.
* **Only published products.** Searches are scoped to `status:ACTIVE`.

## Architecture

```
src/
  config/index.ts             env loading + validation (lazy, memoised)
  shopify/
    client.ts                 Admin API client + error normalisation
    queries.ts                all GraphQL documents
    service.ts                reusable Shopify reads
    types.ts                  raw Shopify response shapes
  products/
    product.types.ts          public API shapes
    product.mapper.ts         Shopify node -> public Product
    product.filters.ts        price / size / colour / availability
    product.category.ts       category inference (shirt vs t-shirt vs polo)
    product.ranking.ts        deterministic relevance score  <-- swap for semantic search here
    product.search.ts         search orchestration + Shopify query building
    product.validation.ts     input validation
    product.service.ts        facade used by routes AND connector
  routes/
    health.ts  search.ts  products.ts
  connector/
    tools.ts                  AI tool definitions + dispatcher
    schemas.ts                shared product JSON Schema (OpenAPI + MCP output)
    server.ts                 HTTP surface for the tools
    openapi.ts                OpenAPI doc for ChatGPT Actions
  mcp/
    server.ts                 MCP server: tool list, dispatch, error mapping
    stdio.ts                  stdio transport entry point (local MCP clients)
    http.ts                   Streamable HTTP transport (remote MCP clients)
  utils/
    auth.ts  errors.ts  text.ts
  app.ts                      Fastify app assembly, error handler, logging
  server.ts                   process entry point
tests/                        unit + HTTP tests (Shopify fully mocked)
```

The layers are strictly separated: **no GraphQL exists outside `src/shopify/`**, and
both the REST routes and the MCP server call the product service rather than
duplicating Shopify logic. `src/mcp/server.ts` adapts the very same
`TOOL_DEFINITIONS` the REST connector serves, so the two can never drift.

## 1. Install

```bash
npm install
```

Requires Node.js 20+ (developed on Node 23).

## 2. Configure `.env`

Copy the example and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | yes | – | `your-store.myshopify.com` (no protocol) |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | yes | – | Admin API access token (`shpat_…` / `shpca_…`) |
| `SHOPIFY_API_VERSION` | no | `2026-07` | Admin GraphQL version; bump when you migrate |
| `SHOPIFY_STOREFRONT_URL` | no | `https://<store domain>` | Public domain used to build product URLs |
| `PORT` | no | `3000` | HTTP port |
| `HOST` | no | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | no | `info` | pino log level |
| `CONNECTOR_API_KEY` | no | *(unset)* | When set, every `/api`, `/connector` and `/mcp` call needs `Authorization: Bearer <key>`. Leave empty to disable auth locally. Does not apply to stdio, which is already a private channel. |

`SHOPIFY_STORE` and `SHOPIFY_ACCESS_TOKEN` are accepted as aliases for the first two.

The app needs the `read_products` scope. `read_inventory` is optional — without it,
`inventory_quantity` comes back as `null` and everything else still works.

> `.env` is git-ignored. The Admin token is used server-side only, is never returned
> in a response, and is scrubbed from logs and error messages.

## 3. Run locally

```bash
npm run dev      # HTTP server, watch mode (tsx)
npm run build    # compile to dist/
npm start        # run the compiled HTTP server

npm run mcp      # MCP server on stdio (what an MCP client spawns)
npm run mcp:start      # the compiled MCP stdio server
npm run mcp:inspect    # open the MCP Inspector against it
```

The HTTP server hosts REST, OpenAPI **and** MCP-over-HTTP. The stdio entry point is
a separate process for local MCP clients — you do not need both.

## 4. Other scripts

```bash
npm test         # unit + HTTP + MCP tests — no live Shopify store needed
npm run lint     # eslint
npm run typecheck # tsc --noEmit for src and tests
```

Tests mock the Shopify API entirely (stubbed `fetch` and injected dependencies), so
they run offline and never touch a real store.

## API

All endpoints return JSON. Errors use the shape
`{ "error": { "code": "...", "message": "..." } }`.

### `GET /health`

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Dependency-free, suitable for deployment health checks. Never requires an API key.

### `POST /api/search-products`

Only `query` is required.

```bash
curl -X POST http://localhost:3000/api/search-products \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "black shirt",
    "max_price": 2000,
    "min_price": null,
    "size": "L",
    "color": "black",
    "limit": 5
  }'
```

| Field | Type | Rules |
| --- | --- | --- |
| `query` | string | required, 1–200 chars |
| `min_price` / `max_price` | number \| null | ≥ 0, `min_price` ≤ `max_price` |
| `size` | string \| null | ≤ 40 chars; `L`, `Large`, `XL`, `2XL`… all understood |
| `color` | string \| null | ≤ 40 chars |
| `limit` | integer \| null | 1–20, default 5 |

`category_match` appears on each result only when `query` names a product category
(`shirt`, `t-shirt`, `polo`, `dress`, `jeans`, `jacket`, …). `exact` means the product
is that category; `related` means it is a substitute. A free-form query such as
*"something casual for dinner"* names no category, so the field is absent.

Response:

```json
{
  "products": [
    {
      "id": "gid://shopify/Product/10660934254870",
      "title": "Regular Fit Rib Long Sleeve T-Shirt",
      "handle": "regular-fit-rib-long-sleeve-t-shirt",
      "url": "https://your-store.myshopify.com/products/regular-fit-rib-long-sleeve-t-shirt",
      "description": "...",
      "price": 2199,
      "currency": "INR",
      "image": "https://cdn.shopify.com/s/files/.../black-1.jpg",
      "available": true,
      "variants": [
        {
          "id": "gid://shopify/ProductVariant/51413011267862",
          "title": "Black / L",
          "price": 2199,
          "available": true,
          "inventory_quantity": 2,
          "options": { "Colour": "Black", "Size": "L" }
        }
      ],
      "tags": ["black", "shirt", "casual"],
      "product_type": "Shirt",
      "category_match": "exact"
    }
  ],
  "total": 1
}
```

More examples:

```bash
# 3 shirts under 2500
curl -X POST http://localhost:3000/api/search-products \
  -H 'Content-Type: application/json' \
  -d '{"query":"shirts","max_price":2500,"limit":3}'

# black regular-fit shirt available in L
curl -X POST http://localhost:3000/api/search-products \
  -H 'Content-Type: application/json' \
  -d '{"query":"regular fit shirt","color":"black","size":"L"}'

# free-form requirement
curl -X POST http://localhost:3000/api/search-products \
  -H 'Content-Type: application/json' \
  -d '{"query":"I need something casual for a dinner","max_price":3000}'
```

### `GET /api/products/:id`

Accepts a URL-encoded product GID or a bare numeric id.

```bash
curl "http://localhost:3000/api/products/gid%3A%2F%2Fshopify%2FProduct%2F123"
curl "http://localhost:3000/api/products/123"      # equivalent
```

Returns everything `search-products` returns, plus `images[]`, `vendor`, `options`,
`price_range` and `total_inventory`:

```json
{
  "id": "gid://shopify/Product/123",
  "title": "Regular Fit Solid Pique Polo",
  "handle": "regular-solid-pique-polo",
  "url": "https://your-store.myshopify.com/products/regular-solid-pique-polo",
  "description": "...",
  "price": 3599,
  "currency": "INR",
  "images": ["https://cdn.shopify.com/..."],
  "tags": ["Polo", "Men"],
  "product_type": "Polo",
  "vendor": "Tommy Hilfiger",
  "available": true,
  "options": [{ "name": "Colour", "values": ["Black", "Red"] }],
  "price_range": { "min": 3475, "max": 3599 },
  "total_inventory": 240,
  "variants": [ /* ... */ ]
}
```

`price` is the lowest **available** variant price, while `price_range` spans all
variants — so they can differ when the cheapest variant is sold out. (On the search
endpoint `price` narrows further, to the variants matching the requested size/colour.)

### Status codes

| Code | When |
| --- | --- |
| `400` | Invalid body, bad limit/price, malformed product id |
| `401` | `CONNECTOR_API_KEY` is set and the bearer token is missing/wrong |
| `404` | Unknown route, or product id not in the catalog |
| `405` | `GET`/`DELETE` on `/mcp` — the MCP transport is stateless and POST-only |
| `502` | Shopify GraphQL / credential / scope failure |
| `503` | Shopify unreachable, throttled, or returning 5xx |

## Use it as an MCP server

Two transports, same server:

| Transport | Entry point | Use it for |
| --- | --- | --- |
| **stdio** | `dist/mcp/stdio.js` (`npm run mcp`) | Local clients that spawn the process — Claude Desktop, Claude Code |
| **Streamable HTTP** | `POST /mcp` on the Fastify app | Remote clients talking to a deployed instance |

### Claude Code

```bash
claude mcp add shopify -- node /absolute/path/to/mcp-connector/dist/mcp/stdio.js
```

Or against a deployed instance:

```bash
claude mcp add --transport http shopify https://your-host.example.com/mcp \
  --header "Authorization: Bearer $CONNECTOR_API_KEY"
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shopify": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-connector/dist/mcp/stdio.js"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "your-store.myshopify.com",
        "SHOPIFY_ADMIN_ACCESS_TOKEN": "shpat_xxxxxxxx"
      }
    }
  }
}
```

Run `npm run build` first, and use absolute paths.

The `env` block is optional: the stdio server resolves `.env` from its own location
on disk, not from the working directory, so it finds the project's `.env` no matter
where the client spawns it from (Claude Desktop uses `/`). Real environment
variables still win over `.env`, so the block above is the way to point one client
at a different store.

### What the client sees

```
tools:
  search_products   query*, min_price, max_price, size, color, limit
  get_product       product_id*
```

Both tools are annotated `readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: true`, so a client can run them without prompting for confirmation.
Both declare an `outputSchema` and return `structuredContent` alongside the text
block, so typed clients get a validated object and text-only clients lose nothing.

On connect the server sends `instructions` telling the model to use these tools for
every product question and never to invent products — you do not need to repeat that
in your system prompt.

### Errors

Tool failures come back as `isError: true` with a `CODE: message` text block
(`BAD_REQUEST: "query" is required…`, `NOT_FOUND: No product found for id…`) rather
than as protocol errors, so the model can read the problem and retry. Shopify tokens
are scrubbed from these messages like everywhere else.

### Checking it by hand

```bash
npm run mcp:inspect        # MCP Inspector, no client needed

# or raw JSON-RPC over stdio
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp/stdio.js
```

## Publishing it for Gemini / Antigravity users

Google retired Gemini CLI on 18 June 2026 and replaced it with **Antigravity CLI**
(the `agy` command). What were "Gemini CLI extensions" are now **Antigravity plugins**,
and the manifest changed: a single `gemini-extension.json` became `plugin.json` plus
`mcp_config.json`. Antigravity speaks MCP, so this server needs no new code — only
packaging.

### Do not ship your Admin token

The obvious route — publish a plugin that runs `dist/mcp/stdio.js` on each user's
machine — requires every user to hold `SHOPIFY_ADMIN_ACCESS_TOKEN`. That is **your**
store's write-capable Admin credential. Handing it out is not an option.

So for a plugin anyone can install, **you host the server and they connect to it**:

```
  their Antigravity CLI  ──HTTPS──▶  your deployed server  ──▶  Shopify Admin API
       (plugin: serverUrl)              (holds the token)
```

The local stdio route stays the right one for *you* and your own team, where everyone
legitimately has the token.

### 1. Deploy the HTTP server

A `Dockerfile` and `.dockerignore` are included. The build is multi-stage, runs as the
`node` user, and `.dockerignore` excludes `.env` so a local token can never be baked
into an image.

```bash
docker build -t shopify-mcp .
docker run -p 3000:3000 \
  -e SHOPIFY_STORE_DOMAIN=your-store.myshopify.com \
  -e SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxx \
  shopify-mcp
```

Any container host works (Cloud Run, Railway, Render, Fly.io, ECS). Set the environment
variables from the table above, point the health check at `GET /health`, and make sure
the proxy does not buffer responses or SSE streaming will stall. Your MCP endpoint is
then `https://your-host/mcp`.

#### Google Cloud Run

Cloud Run builds the image for you, so Docker does not need to be installed locally.
`.gcloudignore` keeps `.env` out of the upload — without it `gcloud` falls back to
`.gitignore`, and a token in a build bucket is a bad day.

```bash
PROJECT=your-project
REGION=asia-south1

gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com --project="$PROJECT"

# Secrets belong in Secret Manager, not --set-env-vars: env vars are readable by
# anyone with project Viewer and are visible in the revision's configuration.
printf '%s' "$SHOPIFY_ADMIN_ACCESS_TOKEN" \
  | gcloud secrets create shopify-admin-token --data-file=- --project="$PROJECT"
printf '%s' "$CONNECTOR_API_KEY" \
  | gcloud secrets create connector-api-key --data-file=- --project="$PROJECT"

gcloud run deploy shopify-mcp \
  --source . --region "$REGION" --project "$PROJECT" \
  --allow-unauthenticated \
  --set-env-vars "SHOPIFY_STORE_DOMAIN=your-store.myshopify.com,SHOPIFY_API_VERSION=2026-07,NODE_ENV=production" \
  --set-secrets "SHOPIFY_ADMIN_ACCESS_TOKEN=shopify-admin-token:latest,CONNECTOR_API_KEY=connector-api-key:latest"
```

No code changes are needed: Cloud Run injects `$PORT` (8080) and the config already
reads it, `HOST` already defaults to `0.0.0.0`, and `trustProxy` is already on so
client IPs survive the proxy.

`--allow-unauthenticated` controls *Google IAM*, not your own auth — it makes the URL
reachable, and `CONNECTOR_API_KEY` is what actually gates it. Without the flag only
callers with a Google identity can connect, which no Antigravity plugin user will have.

### 2. Write the plugin manifest

Two files at the repository root (both included here):

`plugin.json` — identity only. The schema sets `additionalProperties: false`, so `name`,
`description` and `$schema` are the only keys allowed; MCP servers do **not** go here.

```json
{
  "$schema": "https://antigravity.google/schemas/v1/plugin.json",
  "name": "shopify-shopping",
  "description": "Search a live Shopify product catalog by natural-language shopping requirements."
}
```

`mcp_config.json` — the server connection. Replace the placeholder host with your own:

```json
{
  "mcpServers": {
    "shopify-shopping": {
      "serverUrl": "https://your-host.example.com/mcp"
    }
  }
}
```

Use `serverUrl` for remote servers — `url` and `httpUrl` are legacy and are **not**
supported. If you set `CONNECTOR_API_KEY`, add the token:

```json
"headers": { "Authorization": "Bearer your-connector-key" }
```

Note that a key committed to a public plugin repo is readable by anyone, so it gates
casual traffic rather than being a real secret. For a stdio plugin instead, swap
`serverUrl` for `command` / `args` / `env` / `cwd`.

### 3. Publish and install

Push the repo; users install straight from it:

```bash
agy plugin install https://github.com/<you>/mcp-connector
```

Validate before publishing (needs `agy` installed):

```bash
agy plugin validate .
```

For one-off use without a plugin, `agy mcp add` also works:

```bash
agy mcp add shopify-shopping -t http https://your-host.example.com/mcp
```

Listing on the official marketplace (`<name>@antigravity-plugins-official`) is a separate
submission; the GitHub URL above works without it.

### Before you make it public

Each tool call hits the Shopify Admin API, which is **cost-based rate limited**. A public
endpoint with no inbound limiting lets one noisy client exhaust your API budget and get
your whole store throttled. Add rate limiting (and ideally caching) before sharing the
URL widely — see the open items at the end of this README.

Also note `read_products` is enough for this server; do not issue it a token with write
scopes it never uses.

## The REST connector (non-MCP clients)

For runtimes that do not speak MCP. It is a thin layer over the same product
service and contains **no Shopify logic of its own** — the MCP server adapts these
very same definitions.

### Tool definitions

`GET /connector/tools` returns JSON-schema tool definitions ready to paste into an
agent runtime:

```bash
curl http://localhost:3000/connector/tools
```

* **`search_products`** — *"Search the live Shopify product catalog. Use this whenever
  a user asks to find, compare or recommend products based on attributes such as
  product type, price, color, size, availability or keywords. Never invent products.
  Only recommend products returned by this tool."*
  Input: `query` (required), `min_price`, `max_price`, `size`, `color`, `limit`.
* **`get_product`** — *"Retrieve detailed information about a specific Shopify product
  returned by search_products."* Input: `product_id`.

### Invoking a tool

```bash
curl -X POST http://localhost:3000/connector/tools/search_products \
  -H 'Content-Type: application/json' \
  -d '{"query":"polo","max_price":3000,"limit":2}'
# {"tool":"search_products","result":{"products":[...],"total":2}}

curl -X POST http://localhost:3000/connector/tools/get_product \
  -H 'Content-Type: application/json' \
  -d '{"product_id":"gid://shopify/Product/123"}'
```

### In-process use

```ts
import { TOOL_DEFINITIONS, callTool } from './src/connector/tools.js';

const result = await callTool('search_products', { query: 'black shirt', max_price: 2000 });
```

### Wiring it to an agent

* **Any MCP client** — use the MCP server above. Nothing here is needed.
* **ChatGPT custom GPT / Actions** — import `GET /openapi.json` (served by this app) as
  the Action schema, and set authentication to *API key → Bearer* with your
  `CONNECTOR_API_KEY`. The two operations appear as `search_products` and `get_product`.
* **Anthropic Messages API / other tool-calling APIs** — pass `TOOL_DEFINITIONS` (or the
  JSON from `GET /connector/tools`) as the tool list and route calls through `callTool`
  or `POST /connector/tools/:name`.

For the non-MCP paths, add this to the agent's system prompt (MCP clients receive it
automatically as server `instructions`):

> Use `search_products` for every product question. Only recommend products it
> returns — never invent products, prices, or availability. Use `get_product` when
> the shopper asks for more detail about a specific result.

## Security

* The Admin token stays server-side; it is never returned in a response and is
  redacted from logs and error messages.
* `.env` is git-ignored — commit `.env.example` only.
* All input is validated at both the HTTP schema layer and the service layer (the
  connector and the MCP server call the service directly, so validation cannot be
  bypassed).
* Optional bearer-token auth via `CONNECTOR_API_KEY`, compared in constant time.
  It covers `/mcp` as well as `/api` and `/connector`; `/health` stays public so
  deploy probes keep working.
* The MCP HTTP transport is stateless — a fresh transport and server per request,
  so concurrent clients cannot collide on request ids or observe each other.
* Request bodies are capped at 256 KB.

```bash
CONNECTOR_API_KEY=my-secret npm start
curl -X POST http://localhost:3000/api/search-products \
  -H 'Authorization: Bearer my-secret' \
  -H 'Content-Type: application/json' \
  -d '{"query":"shirt"}'
```

## Deploy

The app is a stateless Node process — no database, no cache, no background jobs.

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

1. Set the environment variables from the table above in your host
   (Railway, Render, Fly.io, Heroku, ECS, …).
2. Set `CONNECTOR_API_KEY` in production — the API is otherwise open.
3. Point the health check at `GET /health`.
4. The server listens on `$PORT` / `$HOST` and handles `SIGINT`/`SIGTERM` for
   graceful shutdown, so it works behind a load balancer as-is.
5. Remote MCP clients connect to `POST /mcp` on the same host. Make sure your proxy
   does not buffer responses, or SSE streaming will stall.

A production `Dockerfile` is included (multi-stage, non-root, `.env` excluded):

```bash
docker build -t shopify-mcp .
```

## Swapping in semantic search later

Ranking is isolated in `src/products/product.ranking.ts` behind
`rankProducts(products, params)`. Replacing that one function with an
embedding-based ranker requires no changes to routes, filters, or the connector.

## Known limitations

Honest list of what this does not do yet.

* **No pagination.** The candidate pool is capped at 100 products
  (`candidatePoolSize`), so on a large catalog a broad query only ever considers the
  first 100 by Shopify relevance. There is no cursor.
* **`total` is the result count, not the match count.** It equals `products.length`;
  it does not tell you how many products in the catalog matched.
* **No caching and no inbound rate limiting.** Every tool call reaches the Shopify
  Admin API, which is cost-based rate limited. Fix this before exposing the server
  publicly.
* **No readiness probe against Shopify.** `GET /health` is deliberately
  dependency-free. `fetchShop()` exists in `src/shopify/service.ts` and is unused —
  it is what a `/ready` endpoint would call.
* **Fastify deprecation.** The top-level `disableRequestLogging` option in
  `src/app.ts` is removed in Fastify 6.
