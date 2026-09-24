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
  /** Staged bytes by attachment id — the fake of the private storage bucket. */
  staged: Map<string, { filename: string; contentType: string; bytes: Uint8Array }>;
  completedClaims: string[][];
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

const GRAPH_HOST = 'https://graph.microsoft.test/v1.0';

// An OpenAPI connector shaped like a customer's Microsoft Graph spec:
// `POST /users/{user}/sendMail` with the attachment array nested in the body.
const graphConnector: GatewayConnector = {
  connectorId: 'conn-graph',
  slug: 'graph',
  provider: 'openapi',
  baseUrl: null,
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

const graphSendMail: GatewayAction = {
  path: 'graph.sendmail',
  relPath: 'sendmail',
  inputSchema: {
    type: 'object',
    properties: {
      user: { type: 'string', 'x-in': 'path' },
      body: {
        type: 'object',
        properties: {
          message: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              body: { type: 'object' },
              toRecipients: { type: 'array' },
              attachments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    '@odata.type': { type: 'string' },
                    name: { type: 'string' },
                    contentType: { type: 'string' },
                    contentBytes: { type: 'string', format: 'base64url' },
                  },
                },
              },
            },
          },
          saveToSentItems: { type: 'boolean' },
        },
      },
    },
    required: ['user', 'body'],
  },
  risk: 'write',
  binding: {
    kind: 'openapi',
    method: 'POST',
    path: '/users/{user}/sendMail',
    server: GRAPH_HOST,
  },
};

/** Graph's real answer when the body is not a JSON object labelled as JSON. */
function fakeGraph(init: { headers: Record<string, string>; body?: string }) {
  const contentTypes = Object.entries(init.headers)
    .filter(([key]) => key.toLowerCase() === 'content-type')
    .map(([, value]) => value);
  let parsed: unknown = null;
  try {
    parsed = init.body ? JSON.parse(init.body) : null;
  } catch {
    parsed = null;
  }
  const ok =
    contentTypes.length === 1 &&
    contentTypes[0] === 'application/json' &&
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed);
  return ok
    ? { status: 202, ok: true, text: async () => '' }
    : {
        status: 400,
        ok: false,
        text: async () =>
          JSON.stringify({
            error: {
              code: 'BadRequest',
              message:
                'Unable to read JSON request payload. Please ensure Content-Type header is set and payload is of valid JSON format.',
            },
          }),
      };
}

/** Synthetic PDF, ~0.9 MB, containing every byte value. */
function syntheticPdf(size = 900_000): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  for (let i = 9; i < size; i++) bytes[i] = (i * 31) % 256;
  return bytes;
}

function graphSendMailArgs() {
  return {
    user: 'sender@example.com',
    body: {
      message: {
        subject: 'Weekly report',
        body: { contentType: 'Text', content: 'Hi,\rthe report is attached.' },
        toRecipients: [{ emailAddress: { address: 'recipient@example.com' } }],
      },
      saveToSentItems: true,
    },
  };
}

function principal(): ConnectorPrincipal {
  return {
    userId: USER,
    accountId: ACCOUNT,
    projectId: PROJECT,
    sessionId: 'sess-faces',
    subject: { userId: USER, groupIds: [] },
    agentGrant: {
      agent: 'test-agent',
      connectors: ['echo', 'graph', 'kortix_email'],
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
    {
      slug: graphConnector.slug,
      name: 'Microsoft Graph',
      provider: graphConnector.provider,
      status: 'active',
      actions: [
        {
          path: graphSendMail.relPath,
          name: graphSendMail.path,
          description: 'Send mail',
          risk: graphSendMail.risk,
          inputSchema: graphSendMail.inputSchema,
        },
      ],
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
      const attachmentId = crypto.randomUUID();
      world.staged.set(attachmentId, {
        filename: input.filename,
        contentType: input.contentType,
        bytes: input.bytes,
      });
      return {
        attachment_id: attachmentId,
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
    claimInline: async (_scope: unknown, attachmentIds: string[]) => ({
      claimToken: 'claim-1',
      attachmentIds,
      files: new Map(
        attachmentIds.map((id) => {
          const staged = world.staged.get(id);
          if (!staged) throw new Error('attachment_not_found');
          return [
            id,
            {
              filename: staged.filename,
              contentType: staged.contentType,
              contentDisposition: 'attachment' as const,
              bytes: staged.bytes,
            },
          ];
        }),
      ),
    }),
    completeClaim: async (_token: string, attachmentIds: string[]) => {
      world.completedClaims.push(attachmentIds);
    },
    releaseClaim: async () => {},
  };
  const gateway: GatewayDeps = {
    attachmentStore,
    loadConnectorBySlug: async (_projectId, slug) =>
      slug === connector.slug ? connector : slug === graphConnector.slug ? graphConnector : null,
    loadAction: async (connectorId, relPath) => {
      if (connectorId === graphConnector.connectorId) {
        return relPath === graphSendMail.relPath ? graphSendMail : null;
      }
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
      if (url.startsWith(GRAPH_HOST)) return fakeGraph(init);
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
      KORTIX_TOKEN: TOKEN,
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
  world = {
    executions: [],
    upstream: [],
    attachmentUploads: [],
    staged: new Map(),
    completedClaims: [],
  };
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
    // The denial names the agent, what it holds, and where that came from —
    // the stable `reason` stays; the rest is what an agent needs to fix it.
    expect(await response.json()).toEqual({
      ok: false,
      status: 'denied',
      reason: 'connector_not_assigned',
      connector: 'other',
      action: 'get',
      agent: 'test-agent',
      granted: ['echo', 'graph', 'kortix_email'],
      manifest_revision: null,
      manifest_commit: null,
      hint: expect.stringContaining('agents.test-agent.connectors'),
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
      expect(await response.json()).toMatchObject({
        ok: false,
        status: 'denied',
        reason: 'connector_not_assigned',
        connector: 'kortix_email',
        agent: 'test-agent',
        granted: [],
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
        KORTIX_TOKEN: TOKEN,
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
        // Stages one file and returns its `$kortix_attachment` reference.
        'upload_attachment',
        // Lists an account's `me`/`project`/named accounts (connector-gateway/mcp.ts)
        // so a caller can choose WHICH connection a call runs as before calling.
        'accounts',
        'connect',
        'finalize_connection',
        'request_secret',
        'secret_call',
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

  test('attachment_files reach a Microsoft Graph sendMail upstream as inline bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kortix-connectors-mcp-'));
    const artifacts = join(workspace, 'artifacts');
    const report = join(artifacts, 'weekly report_20260923.pdf');
    const pdf = syntheticPdf();
    await mkdir(artifacts);
    await writeFile(report, pdf);

    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'connectors', 'mcp'],
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KORTIX_API_URL: apiUrl,
        KORTIX_TOKEN: TOKEN,
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
      expect(callTool.inputSchema.properties.attachment_path.type).toBe('string');

      const called = await requestMcp(proc, reader, 2, 'tools/call', {
        name: 'call',
        arguments: {
          connector: 'graph',
          action: 'sendmail',
          args: graphSendMailArgs(),
          attachment_files: [{ path: report }],
        },
      });
      const text = called.content[0].text as string;
      expect(called.isError).toBe(false);
      expect(JSON.parse(text)).toMatchObject({ ok: true, risk: 'write' });

      // The upstream received one JSON request with the file inline.
      const hit = world.upstream.at(-1)!;
      expect(hit.url).toBe(`${GRAPH_HOST}/users/sender%40example.com/sendMail`);
      expect(hit.headers['Content-Type']).toBe('application/json');
      expect(hit.headers.Authorization).toBe(`Bearer ${SERVER_SECRET}`);
      const sent = JSON.parse(hit.body!);
      expect(sent.saveToSentItems).toBe(true);
      expect(sent.message.subject).toBe('Weekly report');
      expect(sent.message.attachments).toHaveLength(1);
      const attachment = sent.message.attachments[0];
      expect(attachment).toMatchObject({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'weekly report_20260923.pdf',
        contentType: 'application/pdf',
      });
      expect(Object.keys(attachment).sort()).toEqual(
        ['@odata.type', 'contentBytes', 'contentType', 'name'].sort(),
      );
      // Byte-for-byte after base64 decode.
      expect(Buffer.from(attachment.contentBytes, 'base64').equals(Buffer.from(pdf))).toBe(true);

      // The bytes never enter the model-visible result or the audit row.
      const fingerprint = attachment.contentBytes.slice(1_000, 1_064);
      expect(text).not.toContain(fingerprint);
      expect(JSON.stringify(world.executions)).not.toContain(fingerprint);
      expect(world.completedClaims).toHaveLength(1);
    } finally {
      proc.kill();
      await proc.exited;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('attachment_files refuse an action whose schema has no attachments array', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kortix-connectors-mcp-'));
    await mkdir(join(workspace, 'output'));
    const memo = join(workspace, 'output', 'memo.pdf');
    await writeFile(memo, 'pdf');
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'connectors', 'mcp'],
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KORTIX_API_URL: apiUrl,
        KORTIX_TOKEN: TOKEN,
        KORTIX_INTERNAL_WORKSPACE_ROOT: workspace,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = proc.stdout.getReader();
    try {
      const called = await requestMcp(proc, reader, 1, 'tools/call', {
        name: 'call',
        arguments: {
          connector: 'echo',
          action: 'get',
          args: { q: 'x' },
          attachment_files: [{ path: memo }],
        },
      });
      expect(called.isError).toBe(true);
      expect(JSON.parse(called.content[0].text).error).toContain(
        'echo.get does not accept attachments',
      );
      expect(world.attachmentUploads).toEqual([]);
      expect(world.upstream).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('Microsoft Graph sendMail through the CLI face', () => {
  test('--attach with @file args delivers the PDF as a Graph fileAttachment', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kortix-connectors-cli-'));
    const artifacts = join(workspace, 'artifacts');
    await mkdir(artifacts);
    const report = join(artifacts, 'report.pdf');
    const pdf = syntheticPdf();
    await writeFile(report, pdf);
    const argsFile = join(workspace, 'args.json');
    await writeFile(argsFile, JSON.stringify(graphSendMailArgs()));
    try {
      const result = await runCli(
        ['call', 'graph.sendmail', `@${argsFile}`, '--attach', report],
        { KORTIX_INTERNAL_WORKSPACE_ROOT: workspace },
      );
      expect(result).toMatchObject({ ok: true, risk: 'write' });
      const sent = JSON.parse(world.upstream.at(-1)!.body!);
      expect(sent.message.attachments[0].name).toBe('report.pdf');
      expect(
        Buffer.from(sent.message.attachments[0].contentBytes, 'base64').equals(Buffer.from(pdf)),
      ).toBe(true);
      expect(world.attachmentUploads.map((upload) => upload.filename)).toEqual(['report.pdf']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('a caller-supplied base64 attachment and a string body both reach Graph as valid JSON', async () => {
    const args = graphSendMailArgs();
    const withInline = {
      ...args,
      body: {
        ...args.body,
        message: {
          ...args.body.message,
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'small.txt',
              contentType: 'text/plain',
              contentBytes: Buffer.from('hello').toString('base64'),
            },
          ],
        },
      },
    };
    const objectBody = await runCli(['call', 'graph.sendmail', JSON.stringify(withInline)]);
    expect(objectBody).toMatchObject({ ok: true });

    // An agent that serialized the body itself used to get HTTP 400 from Graph.
    const stringBody = await runCli([
      'call',
      'graph.sendmail',
      JSON.stringify({ ...withInline, body: JSON.stringify(withInline.body) }),
    ]);
    expect(stringBody).toMatchObject({ ok: true });
    expect(world.upstream.map((hit) => JSON.parse(hit.body!))).toEqual([
      withInline.body,
      withInline.body,
    ]);
  });

  test('upload prints a ref that works as an explicit contentBytes value', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kortix-connectors-cli-'));
    await mkdir(join(workspace, 'output'));
    const report = join(workspace, 'output', 'q3.pdf');
    const pdf = syntheticPdf(4_096);
    await writeFile(report, pdf);
    try {
      const uploaded = await runCli(['upload', report, '--connector', 'graph'], {
        KORTIX_INTERNAL_WORKSPACE_ROOT: workspace,
      });
      expect(uploaded).toMatchObject({
        ok: true,
        filename: 'q3.pdf',
        content_type: 'application/pdf',
        ref: { $kortix_attachment: uploaded.attachment_id },
      });

      const args = graphSendMailArgs() as any;
      args.body.message.attachments = [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'Q3 report.pdf',
          contentType: 'application/pdf',
          contentBytes: uploaded.ref,
        },
      ];
      const result = await runCli(['call', 'graph.sendmail', JSON.stringify(args)]);
      expect(result).toMatchObject({ ok: true });
      const sent = JSON.parse(world.upstream.at(-1)!.body!);
      expect(sent.message.attachments[0].name).toBe('Q3 report.pdf');
      expect(
        Buffer.from(sent.message.attachments[0].contentBytes, 'base64').equals(Buffer.from(pdf)),
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("an upstream API's own attachment_id values pass through untouched", async () => {
    const args = { text: 'fwd', attachments: [{ attachment_id: 'provider-att-42' }] };
    const result = await runCli(['call', 'echo', 'reply', JSON.stringify(args)]);
    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(world.upstream.at(-1)!.body!)).toEqual(args);
  });

  test('an agent without the target connector cannot stage a file for it', async () => {
    const response = await fetch(`${apiUrl}/v1/connectors/attachments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DENIED_TOKEN}`,
        'Content-Type': 'application/pdf',
        'X-Kortix-Attachment-Filename': 'report.pdf',
        'X-Kortix-Attachment-Connector': 'graph',
      },
      body: 'pdf',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'connector_not_assigned' });
    expect(world.attachmentUploads).toEqual([]);
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
