/**
 * E2E for the Connector user-facing surfaces. These tests run the SDK, CLI,
 * optional MCP compatibility server, and a sandbox-agent-style env-only
 * invocation against a live Hono router backed by the real gateway path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKortix } from '@kortix/sdk';
import type {
  ExecutionRecord,
  GatewayAction,
  GatewayConnector,
  GatewayDeps,
} from '../connectors/gateway';
import {
  type CatalogConnector,
  type ConnectorPrincipal,
  type ConnectorRouterDeps,
  createConnectorRouter,
} from '../connectors/router';

const ACCOUNT = 'acct-faces';
const PROJECT = 'proj-faces';
const USER = 'user-faces';
const TOKEN = 'kortix_test_connector_faces';
const DENIED_TOKEN = 'kortix_test_connector_faces_no_email';
const SERVER_SECRET = 'server_side_secret';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// The Connector's CLI + MCP faces are now subcommands of the one kortix CLI:
// `kortix connectors …` and `kortix connectors mcp`.
const CLI_ENTRY = resolve(REPO_ROOT, 'apps/cli/src/index.ts');

interface World {
  executions: ExecutionRecord[];
  upstream: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
  attachmentUploads: Array<{ filename: string; bytes: string }>;
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

const attachmentAction: GatewayAction = {
  path: 'echo.reply',
  relPath: 'reply',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      attachments: { type: 'array' },
    },
  },
  risk: 'write',
  binding: { kind: 'http', method: 'POST', path: '/reply' },
};

function principal(): ConnectorPrincipal {
  return {
    userId: USER,
    accountId: ACCOUNT,
    projectId: PROJECT,
    sessionId: 'sess-faces',
    subject: { userId: USER, groupIds: [] },
    agentGrant: {
      agent: 'test-agent',
      connectors: ['echo', 'kortix_email'],
      kortixCli: 'all',
    },
  };
}

function catalogFor(_p: ConnectorPrincipal): CatalogConnector[] {
  return [
    {
      slug: connector.slug,
      name: 'Echo',
      provider: connector.provider,
      status: 'active',
      actions: [action, attachmentAction].map((item) => ({
        path: item.relPath,
        name: item.path,
        description: item === action ? 'Echo a query value' : 'Echo a message with attachments',
        risk: item.risk,
        inputSchema: item.inputSchema,
      })),
    },
  ];
}

function makeDeps(): ConnectorRouterDeps {
  const attachmentStore = {
    stage: async (
      _scope: unknown,
      input: {
        filename: string;
        bytes: Uint8Array;
        contentType: string;
        contentDisposition: 'attachment' | 'inline';
        contentId?: string;
      },
    ) => {
      world.attachmentUploads.push({
        filename: input.filename,
        bytes: new TextDecoder().decode(input.bytes),
      });
      return {
        attachment_id: '019fc40d-04dd-7f52-a591-65ab13d2a245',
        filename: input.filename,
        content_type: input.contentType,
        content_disposition: input.contentDisposition,
        ...(input.contentId ? { content_id: input.contentId } : {}),
        size: input.bytes.byteLength,
        expires_at: '2026-08-03T20:00:00.000Z',
      };
    },
    claimForEmail: async (_scope: unknown, args: Record<string, unknown>) => ({
      args,
      claimToken: null,
      attachmentIds: [],
    }),
    completeClaim: async () => {},
    releaseClaim: async () => {},
  };
  const gateway: GatewayDeps = {
    attachmentStore,
    loadConnectorBySlug: async (_projectId, slug) => (slug === connector.slug ? connector : null),
    loadAction: async (connectorId, relPath) => {
      if (connectorId !== connector.connectorId) return null;
      if (relPath === action.relPath) return action;
      return relPath === attachmentAction.relPath ? attachmentAction : null;
    },
    resolveCredential: async () => SERVER_SECRET,
    loadPolicies: async () => [],
    recordExecution: async (rec) => {
      world.executions.push(rec);
      return null;
    },
    fetchImpl: async (url, init) => {
      world.upstream.push({ url, ...init });
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            url,
            auth: init.headers.Authorization,
            body: init.body ? JSON.parse(init.body) : null,
          }),
      };
    },
  };

  return {
    attachmentStore,
    // The flag itself has its own unit coverage; this fake reports every flag on.
    featureFlagEnabled: async () => true,
    resolvePrincipal: async (c) => {
      const authorization = c.req.header('authorization');
      if (authorization === `Bearer ${TOKEN}`) return principal();
      if (authorization === `Bearer ${DENIED_TOKEN}`) {
        return {
          ...principal(),
          agentGrant: { agent: 'test-agent', connectors: [], kortixCli: 'all' },
        };
      }
      return null;
    },
    // Project-explicit gateway: same principal, but the project comes from the
    // path (the production impl accepts a logged-in user token here — this is the
    // local-connector unlock). Authorize only the matching project.
    resolveProjectPrincipal: async (c, projectId) => {
      if (projectId !== PROJECT) return null;
      const authorization = c.req.header('authorization');
      if (authorization === `Bearer ${TOKEN}`) return principal();
      if (authorization === `Bearer ${DENIED_TOKEN}`) {
        return {
          ...principal(),
          agentGrant: { agent: 'test-agent', connectors: [], kortixCli: 'all' },
        };
      }
      return null;
    },
    makeGatewayDeps: () => gateway,
    listCatalog: async (p) => catalogFor(p),
    resolveAdmin: async () => null,
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
  };
}

async function runCli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn({
    cmd: ['bun', CLI_ENTRY, 'connectors', ...args],
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KORTIX_API_URL: apiUrl,
      KORTIX_CLI_TOKEN: TOKEN,
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

async function requestMcp(
  proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  id: number,
  method: string,
  params?: unknown,
) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const decoder = new TextDecoder();
  let line = '';
  while (!line.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('MCP process closed before response');
    line += decoder.decode(chunk.value);
  }
  const [first] = line.split('\n');
  if (!first) throw new Error('MCP process returned an empty response');
  const json = JSON.parse(first);
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

beforeEach(() => {
  world = { executions: [], upstream: [], attachmentUploads: [] };
  const app = createConnectorRouter(makeDeps());
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      url.pathname = url.pathname.replace(/^\/v1\/connectors/, '') || '/';
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
    const sdk = createKortix({
      backendUrl: `${apiUrl}/v1`,
      getToken: async () => TOKEN,
    }).project(PROJECT).connectors;
    expect((await sdk.catalog())[0]?.slug).toBe('echo');
    expect((await sdk.search('query'))[0]).toMatchObject({
      tool: 'echo.get',
      connector: 'echo',
      action: 'get',
    });
    expect(await sdk.describe('echo.get')).toMatchObject({ tool: 'echo.get', risk: 'read' });
    const result = await sdk.call<{ auth: string; url: string }>('echo.get', { q: 'sdk' });
    expect(result.ok).toBe(true);
    expect(result.data?.auth).toBe(`Bearer ${SERVER_SECRET}`);
    expect(result.data?.url).toBe('https://example.test/anything?q=sdk');
    expect(world.executions.at(-1)).toMatchObject({
      status: 'ok',
      actingUserId: USER,
      actionPath: 'echo.get',
    });
  });

  test('supports a durable multi-step script workflow without provider secrets in code', async () => {
    const sdk = createKortix({
      backendUrl: `${apiUrl}/v1`,
      getToken: async () => TOKEN,
    }).project(PROJECT).connectors;

    const connectors = await sdk.catalog();
    const echo = connectors.find((c) => c.slug === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.actions.map((a) => a.path)).toContain('get');

    const [match] = await sdk.search('query value', { limit: 1 });
    expect(match).toMatchObject({ tool: 'echo.get', connector: 'echo', action: 'get' });
    if (!match) throw new Error('expected Connector discovery match');

    const schema = await sdk.describe(match.tool);
    expect(schema?.inputSchema).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string', 'x-in': 'query' } },
    });

    const first = await sdk.call<{ auth: string; url: string }>(match.tool, {
      q: 'step-1',
    });
    expect(first.ok).toBe(true);
    expect(first.data?.auth).toBe(`Bearer ${SERVER_SECRET}`);
    if (!first.data) throw new Error('expected first Connector call data');

    const nextQuery = first.data.url.endsWith('step-1') ? 'step-2' : 'unexpected';
    const second = await sdk.call<{ auth: string; url: string }>(match.tool, {
      q: nextQuery,
    });
    expect(second.ok).toBe(true);
    expect(second.data?.url).toBe('https://example.test/anything?q=step-2');

    expect(world.upstream.map((hit) => hit.headers.Authorization)).toEqual([
      `Bearer ${SERVER_SECRET}`,
      `Bearer ${SERVER_SECRET}`,
    ]);
    expect(world.executions.map((rec) => rec.actionPath)).toEqual(['echo.get', 'echo.get']);
  });
});

describe('CLI face', () => {
  test('connectors, discover, describe, and call work as an executable', async () => {
    expect((await runCli(['ls', '--session', 'sess-faces'])).connectors[0]).toMatchObject({
      slug: 'echo',
      tools: ['echo.get', 'echo.reply'],
    });
    expect((await runCli(['discover', 'query'])).matches[0]).toMatchObject({
      tool: 'echo.get',
      risk: 'read',
    });
    expect((await runCli(['show', 'echo.get'])).inputSchema).toMatchObject({ type: 'object' });
    const call = await runCli(['call', 'echo', 'get', '{"q":"cli"}']);
    expect(call).toMatchObject({ ok: true, risk: 'read' });
    expect(call.data.url).toBe('https://example.test/anything?q=cli');
  });

  test('calls the dotted tool reference returned by discover and describe', async () => {
    const call = await runCli(['call', 'echo.get', '{"q":"cli-dotted"}']);
    expect(call).toMatchObject({ ok: true, risk: 'read' });
    expect(call.data.url).toBe('https://example.test/anything?q=cli-dotted');
  });
});

describe('HTTP call validation', () => {
  test('rejects a dotted tool reference before the connector assignment gate', async () => {
    const response = await fetch(`${apiUrl}/v1/connectors/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connector: 'echo.get',
        action: '{"q":"wrong-position"}',
        args: {},
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      status: 'error',
      reason: 'invalid_tool_reference',
      message:
        'The connector field contains a dotted tool reference. Send the connector and action separately.',
      connector: 'echo',
      action: 'get',
    });
  });

  test('keeps connector_not_assigned for a valid connector outside the agent grant', async () => {
    const response = await fetch(`${apiUrl}/v1/connectors/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connector: 'other',
        action: 'get',
        args: {},
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      status: 'denied',
      reason: 'connector_not_assigned',
    });
  });
});

describe('Project-explicit gateway face (the local-connector unlock)', () => {
  test('SDK with a projectId hits /projects/:id/{catalog,call}', async () => {
    const sdk = createKortix({
      backendUrl: `${apiUrl}/v1`,
      getToken: async () => TOKEN,
    }).project(PROJECT).connectors;
    expect((await sdk.catalog())[0]?.slug).toBe('echo');
    const result = await sdk.call<{ url: string }>('echo.get', { q: 'proj-sdk' });
    expect(result.ok).toBe(true);
    expect(result.data?.url).toBe('https://example.test/anything?q=proj-sdk');
  });

  test('CLI with KORTIX_PROJECT_ID set routes through the project-explicit gateway', async () => {
    // This is exactly the local path: a project (here via env, in practice
    // .kortix/link.json or --project) makes `kortix connectors` use the routes that
    // accept a plain user token. Same command, same result as in-sandbox.
    const connectors = await runCli(['ls', '--session', 'sess-faces'], {
      KORTIX_PROJECT_ID: PROJECT,
      KORTIX_SESSION_ID: 'sess-faces',
    });
    expect(connectors.connectors[0]).toMatchObject({
      slug: 'echo',
      tools: ['echo.get', 'echo.reply'],
    });
    const call = await runCli(['call', 'echo', 'get', '{"q":"proj-cli"}'], {
      KORTIX_PROJECT_ID: PROJECT,
    });
    expect(call).toMatchObject({ ok: true, risk: 'read' });
    expect(call.data.url).toBe('https://example.test/anything?q=proj-cli');
  });

  test('an unauthorized project is rejected (403 → SDK throws)', async () => {
    const sdk = createKortix({
      backendUrl: `${apiUrl}/v1`,
      getToken: async () => TOKEN,
    }).project('someone-elses-project').connectors;
    await expect(sdk.catalog()).rejects.toThrow();
  });

  test('both attachment routes reject agents without the email connector before staging bytes', async () => {
    for (const path of [
      '/v1/connectors/attachments',
      `/v1/connectors/projects/${PROJECT}/attachments`,
    ]) {
      const response = await fetch(`${apiUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${DENIED_TOKEN}`,
          'Content-Type': 'application/pdf',
          'X-Kortix-Attachment-Filename': 'memo.pdf',
        },
        body: 'must-not-be-staged',
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        ok: false,
        status: 'denied',
        reason: 'connector_not_assigned',
      });
    }
    expect(world.attachmentUploads).toEqual([]);
  });
});

describe('MCP face', () => {
  test('exposes stable meta-tools and runs the discover→describe→call loop', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'connectors', 'mcp'],
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KORTIX_API_URL: apiUrl,
        KORTIX_CLI_TOKEN: TOKEN,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = proc.stdout.getReader();
    try {
      expect(
        await requestMcp(proc, reader, 1, 'initialize', { protocolVersion: '2025-06-18' }),
      ).toMatchObject({
        serverInfo: { name: 'kortix-connectors' },
      });

      // tools/list is the fixed meta-tool surface — NOT one tool per action.
      const listed = await requestMcp(proc, reader, 2, 'tools/list');
      expect(listed.tools.map((t: { name: string }) => t.name)).toEqual([
        'connectors',
        'discover',
        'describe',
        'call',
        'connect',
        'request_secret',
        'add_connector',
        'remove_connector',
      ]);

      // connectors → catalog with per-connector tool counts.
      const connectors = JSON.parse(
        (await requestMcp(proc, reader, 3, 'tools/call', { name: 'connectors', arguments: {} }))
          .content[0].text,
      );
      expect(connectors.connectors[0]).toMatchObject({ slug: 'echo', provider: 'http', tools: 2 });

      // discover → intent search across usable tools.
      const discovered = JSON.parse(
        (
          await requestMcp(proc, reader, 4, 'tools/call', {
            name: 'discover',
            arguments: { query: 'echo' },
          })
        ).content[0].text,
      );
      expect(discovered.matches[0]).toMatchObject({ tool: 'echo.get', risk: 'read' });

      // describe → one tool's input schema.
      const described = JSON.parse(
        (
          await requestMcp(proc, reader, 5, 'tools/call', {
            name: 'describe',
            arguments: { tool: 'echo.get' },
          })
        ).content[0].text,
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

  test('uploads attachment_files as raw bytes and sends only opaque handles', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kortix-connectors-mcp-'));
    const output = join(workspace, 'output');
    const memo = join(output, 'memo.pdf');
    await mkdir(output);
    await writeFile(memo, 'real-pdf-bytes');

    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'connectors', 'mcp'],
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KORTIX_API_URL: apiUrl,
        KORTIX_CLI_TOKEN: TOKEN,
        KORTIX_INTERNAL_WORKSPACE_ROOT: workspace,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = proc.stdout.getReader();
    try {
      const listed = await requestMcp(proc, reader, 1, 'tools/list');
      const callTool = listed.tools.find((tool: { name: string }) => tool.name === 'call');
      expect(callTool.inputSchema.properties.attachment_files.items.required).toEqual(['path']);

      const called = await requestMcp(proc, reader, 2, 'tools/call', {
        name: 'call',
        arguments: {
          connector: 'echo',
          action: 'reply',
          args: { text: 'attached' },
          attachment_files: [{ path: memo, filename: 'Investment Memo.pdf' }],
        },
      });
      expect(called.isError).toBe(false);
      const payload = JSON.parse(called.content[0].text);
      expect(payload.data.body).toEqual({
        text: 'attached',
        attachments: [
          {
            filename: 'Investment Memo.pdf',
            content_type: 'application/pdf',
            content_disposition: 'attachment',
            attachment_id: '019fc40d-04dd-7f52-a591-65ab13d2a245',
          },
        ],
      });
      expect(world.attachmentUploads).toEqual([
        { filename: 'Investment Memo.pdf', bytes: 'real-pdf-bytes' },
      ]);
      expect(JSON.stringify(payload.data.body)).not.toContain(
        Buffer.from('real-pdf-bytes').toString('base64'),
      );
    } finally {
      proc.kill();
      await proc.exited;
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('sandbox agent flow', () => {
  test('agent can invoke Connector with only injected sandbox env, not third-party secrets', async () => {
    const result = await runCli(['call', 'echo', 'get', '{"q":"sandbox"}'], {
      THIRD_PARTY_SECRET: undefined,
    });
    expect(result.data.auth).toBe(`Bearer ${SERVER_SECRET}`);
    expect(world.upstream[0]?.headers.Authorization).toBe(`Bearer ${SERVER_SECRET}`);
    expect(process.env.THIRD_PARTY_SECRET).toBeUndefined();
  });
});
