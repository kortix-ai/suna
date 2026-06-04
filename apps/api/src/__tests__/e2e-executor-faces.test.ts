/**
 * E2E for the Executor user-facing surfaces. These tests run SDK, CLI, MCP,
 * and a sandbox-agent-style env-only invocation against a live Hono router
 * backed by the real gateway path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecutorClient } from '../../../../packages/executor-sdk/src/index';
import { createExecutorRouter, type CatalogConnector, type ExecutorPrincipal, type ExecutorRouterDeps } from '../executor/router';
import type { ExecutionRecord, GatewayAction, GatewayConnector, GatewayDeps } from '../executor/gateway';
import { isSecretUsableBy } from '../executor/share';

const ACCOUNT = 'acct-faces';
const PROJECT = 'proj-faces';
const USER = 'user-faces';
const TOKEN = 'kortix_test_executor_faces';
const SERVER_SECRET = 'server_side_secret';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EXECUTOR_CLI = resolve(REPO_ROOT, 'apps/sandbox/agent-cli/connectors/executor.ts');
const EXECUTOR_MCP = resolve(REPO_ROOT, 'apps/sandbox/agent-cli/connectors/executor-mcp.ts');

interface World {
  executions: ExecutionRecord[];
  upstream: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
}

let world: World;
let server: ReturnType<typeof Bun.serve>;
let apiUrl: string;

const connector: GatewayConnector = {
  connectorId: 'conn-echo',
  slug: 'echo',
  provider: 'http',
  baseUrl: 'https://example.test',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  shareScope: 'project',
  grants: [],
  credentialMode: 'shared',
  enabled: true,
};

const action: GatewayAction = {
  path: 'echo.get',
  relPath: 'get',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', 'x-in': 'query' },
    },
  },
  risk: 'read',
  binding: { kind: 'http', method: 'GET', path: '/anything' },
};

function principal(): ExecutorPrincipal {
  return {
    userId: USER,
    accountId: ACCOUNT,
    projectId: PROJECT,
    sessionId: 'sess-faces',
    subject: { userId: USER, groupIds: [] },
  };
}

function catalogFor(p: ExecutorPrincipal): CatalogConnector[] {
  if (!isSecretUsableBy(connector.shareScope, connector.grants, p.subject)) return [];
  return [{
    slug: connector.slug,
    name: 'Echo',
    provider: connector.provider,
    status: 'active',
    actions: [{
      path: action.relPath,
      name: action.path,
      description: 'Echo a query value',
      risk: action.risk,
      inputSchema: action.inputSchema,
    }],
  }];
}

function makeDeps(): ExecutorRouterDeps {
  const gateway: GatewayDeps = {
    loadConnectorBySlug: async (_projectId, slug) => (slug === connector.slug ? connector : null),
    loadAction: async (connectorId, relPath) => (connectorId === connector.connectorId && relPath === action.relPath ? action : null),
    resolveCredential: async () => SERVER_SECRET,
    loadPolicies: async () => [],
    recordExecution: async (rec) => { world.executions.push(rec); },
    fetchImpl: async (url, init) => {
      world.upstream.push({ url, ...init });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          url,
          auth: init.headers.Authorization,
          body: init.body ? JSON.parse(init.body) : null,
        }),
      };
    },
  };

  return {
    resolvePrincipal: async (c) => c.req.header('authorization') === `Bearer ${TOKEN}` ? principal() : null,
    makeGatewayDeps: () => gateway,
    listCatalog: async (p) => catalogFor(p),
    resolveAdmin: async () => null,
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    setSharing: async () => false,
  };
}

async function runCli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn({
    cmd: ['bun', EXECUTOR_CLI, ...args],
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KORTIX_API_URL: apiUrl,
      KORTIX_EXECUTOR_TOKEN: TOKEN,
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

async function requestMcp(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>, reader: ReadableStreamDefaultReader<Uint8Array>, id: number, method: string, params?: unknown) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const decoder = new TextDecoder();
  let line = '';
  while (!line.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('MCP process closed before response');
    line += decoder.decode(chunk.value);
  }
  const [first] = line.split('\n');
  const json = JSON.parse(first!);
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

beforeEach(() => {
  world = { executions: [], upstream: [] };
  const app = createExecutorRouter(makeDeps());
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      url.pathname = url.pathname.replace(/^\/v1\/executor/, '') || '/';
      return app.fetch(new Request(url, req));
    },
  });
  apiUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
});

describe('TS SDK face', () => {
  test('connectors, discover, describe, and call work against the gateway', async () => {
    const sdk = createExecutorClient({ apiUrl, token: TOKEN });
    expect((await sdk.connectors())[0]?.slug).toBe('echo');
    expect((await sdk.discover('query'))[0]).toMatchObject({ tool: 'echo.get', connector: 'echo', action: 'get' });
    expect(await sdk.describe('echo.get')).toMatchObject({ tool: 'echo.get', risk: 'read' });
    const result = await sdk.call<{ auth: string; url: string }>('echo', 'get', { q: 'sdk' });
    expect(result.ok).toBe(true);
    expect(result.data?.auth).toBe(`Bearer ${SERVER_SECRET}`);
    expect(result.data?.url).toBe('https://example.test/anything?q=sdk');
    expect(world.executions.at(-1)).toMatchObject({ status: 'ok', actingUserId: USER, actionPath: 'echo.get' });
  });
});

describe('CLI face', () => {
  test('connectors, discover, describe, and call work as an executable', async () => {
    expect((await runCli(['connectors'])).connectors[0]).toMatchObject({ slug: 'echo', tools: ['echo.get'] });
    expect((await runCli(['discover', 'query'])).matches[0]).toMatchObject({ tool: 'echo.get', risk: 'read' });
    expect((await runCli(['describe', 'echo.get'])).inputSchema).toMatchObject({ type: 'object' });
    const call = await runCli(['call', 'echo', 'get', '{"q":"cli"}']);
    expect(call).toMatchObject({ ok: true, risk: 'read' });
    expect(call.data.url).toBe('https://example.test/anything?q=cli');
  });
});

describe('MCP face', () => {
  test('exposes stable meta-tools and runs the discover→describe→call loop', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', EXECUTOR_MCP],
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KORTIX_API_URL: apiUrl,
        KORTIX_EXECUTOR_TOKEN: TOKEN,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = proc.stdout.getReader();
    try {
      expect(await requestMcp(proc, reader, 1, 'initialize', { protocolVersion: '2025-06-18' })).toMatchObject({
        serverInfo: { name: 'kortix-executor' },
      });

      // tools/list is the fixed meta-tool surface — NOT one tool per action.
      const listed = await requestMcp(proc, reader, 2, 'tools/list');
      expect(listed.tools.map((t: { name: string }) => t.name)).toEqual(['connectors', 'discover', 'describe', 'call']);

      // connectors → catalog with per-connector tool counts.
      const connectors = JSON.parse(
        (await requestMcp(proc, reader, 3, 'tools/call', { name: 'connectors', arguments: {} })).content[0].text,
      );
      expect(connectors.connectors[0]).toMatchObject({ slug: 'echo', provider: 'http', tools: 1 });

      // discover → intent search across usable tools.
      const discovered = JSON.parse(
        (await requestMcp(proc, reader, 4, 'tools/call', { name: 'discover', arguments: { query: 'echo' } })).content[0].text,
      );
      expect(discovered.matches[0]).toMatchObject({ tool: 'echo.get', risk: 'read' });

      // describe → one tool's input schema.
      const described = JSON.parse(
        (await requestMcp(proc, reader, 5, 'tools/call', { name: 'describe', arguments: { tool: 'echo.get' } })).content[0].text,
      );
      expect(described).toMatchObject({ tool: 'echo.get', risk: 'read' });
      expect(described.inputSchema).toMatchObject({ type: 'object' });

      // call → run it through the gateway.
      const called = await requestMcp(proc, reader, 6, 'tools/call', {
        name: 'call',
        arguments: { connector: 'echo', action: 'get', args: { q: 'mcp' } },
      });
      expect(called.isError).toBe(false);
      const payload = JSON.parse(called.content[0].text);
      expect(payload.data.url).toBe('https://example.test/anything?q=mcp');
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

describe('sandbox agent flow', () => {
  test('agent can invoke Executor with only injected sandbox env, not third-party secrets', async () => {
    const result = await runCli(['call', 'echo', 'get', '{"q":"sandbox"}'], {
      THIRD_PARTY_SECRET: undefined,
    });
    expect(result.data.auth).toBe(`Bearer ${SERVER_SECRET}`);
    expect(world.upstream[0]?.headers.Authorization).toBe(`Bearer ${SERVER_SECRET}`);
    expect(process.env.THIRD_PARTY_SECRET).toBeUndefined();
  });
});
