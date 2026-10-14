import './setup.env.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PACKAGE_ENV_PATH } from '../src/config/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('PACKAGE_ENV_PATH', () => {
  it('points at the .env beside package.json, not the working directory', () => {
    assert.equal(PACKAGE_ENV_PATH, path.join(repoRoot, '.env'));
  });
});

/**
 * An MCP client spawns the stdio server from a working directory of its own
 * choosing — Claude Desktop uses `/`. If config ever goes back to a cwd-relative
 * .env lookup, the server starts up unconfigured and this test catches it.
 */
describe('stdio server started from an unrelated working directory', () => {
  it('completes a tools/list handshake', async () => {
    const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
    const entry = path.join(repoRoot, 'src', 'mcp', 'stdio.ts');

    // Strip everything setup.env.ts injected: the child must be forced to find
    // the package's own .env on disk, which is the behaviour under test.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    for (const key of Object.keys(env)) {
      if (key.startsWith('SHOPIFY_')) delete env[key];
    }
    delete env.CONNECTOR_API_KEY;

    const child = spawn(tsx, [entry], { cwd: path.sep, env, stdio: ['pipe', 'pipe', 'pipe'] });

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'config-test', version: '1.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const stdout = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`timed out; stderr was: ${stderr}`));
      }, 20_000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        // Resolve as soon as the tools/list reply lands.
        if (buffer.includes('"tools"')) {
          clearTimeout(timer);
          child.kill();
          resolve(buffer);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        // Exiting before the reply means startup failed — surface stderr.
        if (!buffer.includes('"tools"')) reject(new Error(`exited early; stderr was: ${stderr}`));
      });
    });

    assert.match(stdout, /search_products/);
    assert.match(stdout, /get_product/);
    // A cwd-relative .env lookup fails with exactly this message.
    assert.doesNotMatch(stdout, /Missing required environment variable/);
  });
});
