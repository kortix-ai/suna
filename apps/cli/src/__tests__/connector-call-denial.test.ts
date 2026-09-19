import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * A denied connector call must reach the agent WITH its remedy.
 *
 * The gateway answers 403 with `reason`, `requested_account`,
 * `available_accounts`, `hint` and — when nothing is connected — `connect_url`.
 * Both faces used to collapse that to the SDK error's `message`, so an agent
 * read `connector_not_connected` and had no way to continue: the CLI printed
 * `{"ok":false,"error":"connector_not_connected","code":"CONNECTOR_ERROR"}`
 * and the MCP server turned the thrown ApiError into a bare JSON-RPC error.
 *
 * Driven black-box through the real CLI process and the real stdio MCP server
 * against a stub API, because the thing worth pinning is what lands on stdout.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT_ID = 'proj-test-1234';

/** The exact denial the gateway returns for an account name that matches nothing. */
const UNKNOWN_ACCOUNT_DENIAL = {
  ok: false,
  status: 'denied',
  reason: 'connector_not_connected',
  connector: 'crm',
  action: 'whoami',
  requested_account: 'nope',
  available_accounts: ['Work', 'Personal'],
  hint: 'Connector "crm" has no account named "nope". Available: "Work", "Personal". Retry with one of those, or omit `account` for the default.',
};

/** The denial for a connector with no account at all — it carries the link. */
const NOTHING_CONNECTED_DENIAL = {
  ok: false,
  status: 'denied',
  reason: 'connector_not_connected',
  connector: 'crm',
  action: 'whoami',
  available_accounts: [],
  connect_url: 'https://app.kortix.test/connect/tok_123',
  hint: 'Nothing is connected to "crm" yet. Open the connect link.',
};

let server: ReturnType<typeof Bun.serve>;
let captured: Array<{ path: string; body: Record<string, unknown> }> = [];
/** Set per test to control what the stub gateway answers. */
let respondWith: () => Response;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      captured.push({
        path: url.pathname,
        body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
      });
      return respondWith();
    },
  });
});

afterAll(() => server.stop(true));

function cliEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    KORTIX_TOKEN: 'session-agent-token',
    KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
    KORTIX_PROJECT_ID: PROJECT_ID,
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function runCli(args: string[]) {
  captured = [];
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr, payload: JSON.parse(stdout) as Record<string, unknown> };
}

async function callMcpTool(args: Record<string, unknown>) {
  captured = [];
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call', arguments: args } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');

  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'connectors', 'mcp'],
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdin: new TextEncoder().encode(`${requests}\n`),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const response = stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .find((entry) => entry.id === 2);
  if (!response) throw new Error(`no tool response. stdout=${stdout} stderr=${stderr}`);
  if (response.error) throw new Error(`JSON-RPC error instead of a result: ${stdout}`);
  return {
    payload: JSON.parse(response.result.content[0].text) as Record<string, unknown>,
    isError: response.result.isError === true,
  };
}

describe('a denied connector call carries its remedy', () => {
  test('CLI: the 403 body passes through field for field', async () => {
    respondWith = () => jsonResponse(UNKNOWN_ACCOUNT_DENIAL, 403);

    const result = await runCli([
      'connectors',
      'call',
      'crm',
      'whoami',
      '--account',
      'nope',
      '--project',
      PROJECT_ID,
    ]);

    expect(captured[0]?.path).toBe(`/v1/connectors/projects/${PROJECT_ID}/call`);
    expect(captured[0]?.body).toMatchObject({ connector: 'crm', action: 'whoami', account: 'nope' });
    expect(result.code).toBe(1);
    expect(result.payload).toEqual({
      ...UNKNOWN_ACCOUNT_DENIAL,
      ok: false,
      error: 'connector_not_connected',
    });
    // No second `code`: `reason` is the machine-readable field here.
    expect(result.payload.code).toBeUndefined();
  });

  test('CLI: nothing connected hands back the connect link itself', async () => {
    respondWith = () => jsonResponse(NOTHING_CONNECTED_DENIAL, 403);

    const result = await runCli([
      'connectors',
      'call',
      'crm.whoami',
      '--project',
      PROJECT_ID,
    ]);

    expect(result.code).toBe(1);
    expect(result.payload.connect_url).toBe('https://app.kortix.test/connect/tok_123');
    expect(result.payload.available_accounts).toEqual([]);
  });

  test('CLI: an error with no JSON body still reports the CLI code', async () => {
    respondWith = () => new Response('gateway down', { status: 502 });

    const result = await runCli(['connectors', 'call', 'crm.whoami', '--project', PROJECT_ID]);

    expect(result.code).toBe(1);
    expect(result.payload.ok).toBe(false);
    expect(result.payload.code).toBe('CONNECTOR_ERROR');
    expect(typeof result.payload.error).toBe('string');
  });

  test('CLI: a successful call echoes the account it ran as, untouched', async () => {
    respondWith = () =>
      jsonResponse({
        ok: true,
        status: 'ok',
        data: { email: 'sales@example.test' },
        account: {
          connection_id: '11111111-1111-4111-8111-111111111111',
          label: 'Work',
          owner_type: 'project',
        },
      });

    const result = await runCli(['connectors', 'call', 'crm.whoami', '--project', PROJECT_ID]);

    expect(result.code).toBe(0);
    expect(result.payload.account).toEqual({
      connection_id: '11111111-1111-4111-8111-111111111111',
      label: 'Work',
      owner_type: 'project',
    });
  });

  test('MCP: the denial reaches the model as the API body, not a JSON-RPC error', async () => {
    respondWith = () => jsonResponse(UNKNOWN_ACCOUNT_DENIAL, 403);

    const result = await callMcpTool({
      connector: 'crm',
      action: 'whoami',
      account: 'nope',
    });

    expect(result.isError).toBe(true);
    expect(result.payload).toEqual({
      ...UNKNOWN_ACCOUNT_DENIAL,
      ok: false,
      error: 'connector_not_connected',
    });
  });

  test('MCP: a successful call passes the account echo through', async () => {
    respondWith = () =>
      jsonResponse({
        ok: true,
        status: 'ok',
        data: { email: 'me@example.test' },
        account: {
          connection_id: '22222222-2222-4222-8222-222222222222',
          label: 'Personal',
          owner_type: 'member',
        },
      });

    const result = await callMcpTool({ connector: 'crm', action: 'whoami' });

    expect(result.isError).toBe(false);
    expect(result.payload.account).toEqual({
      connection_id: '22222222-2222-4222-8222-222222222222',
      label: 'Personal',
      owner_type: 'member',
    });
  });
});
