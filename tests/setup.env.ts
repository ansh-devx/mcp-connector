/**
 * Must be the FIRST import in every test file: it pins deterministic config
 * before src/config reads process.env, so tests never touch a real store.
 */
process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'shpat_testtoken0000000000000000000000';
process.env.SHOPIFY_API_VERSION = '2026-07';
process.env.SHOPIFY_STOREFRONT_URL = 'https://test-store.myshopify.com';
process.env.LOG_LEVEL = 'silent';
delete process.env.CONNECTOR_API_KEY;
delete process.env.SHOPIFY_STORE;
delete process.env.SHOPIFY_ACCESS_TOKEN;

export {};
