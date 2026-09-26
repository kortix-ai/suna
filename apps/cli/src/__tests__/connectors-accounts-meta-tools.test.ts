import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * The `connectors` and `describe` MCP meta-tools must SHOW that a connector
 * can hold more than one account, without a second round trip.
 *
 * Root cause this guards: `GET /connectors/catalog` used to carry no account
 * information at all, so an agent asked "check my gmail accounts" had nothing
 * to notice — it called `get_profile` on the default connection and answered
 * "one account connected". The catalog now carries `accounts` +
 * `default_account` per connector; this test pins the MCP surface that reads
 * it, driven black-box through the real CLI process and stdio MCP server
 * against a stub API.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT_ID = 'proj-accounts-mcp';

// The real API always returns entitled accounts default-first (see
// `listEntitledConnectorConnections`), so the fixture mirrors that ordering —
// index 0 IS the resolution default, same as production.
const GMAIL_ACCOUNTS = [
  {
    connection_id: '22222222-2222-4222-8222-222222222222',
    label: 'marko@kortix.ai',
    owner_type: 'member',
    is_default: true,
  },
  {
    connection_id: '11111111-1111-4111-8111-111111111111',
    label: 'markokraemer.mail@gmail.com',
    owner_type: 'member',
    is_default: false,
  },
];

const CATALOG = {
  connectors: [
    {
      slug: 'gmail-ffiod0',
      name: 'Gmail',
      provider: 'composio',
      status: 'active',
      actions: [
        {
          path: 'get_profile',
          name: 'Get profile',
          description: 'Get the authenticated profile',
          risk: 'read',
          inputSchema: null,
        },
      ],
      accounts: GMAIL_ACCOUNTS,
      default_account: 'marko@kortix.ai',
    },
    {
      slug: 'stripe',
      name: 'Stripe',
      provider: 'openapi',
      status: 'active',
      actions: [],
      accounts: [
        {
          connection_id: '33333333-3333-4333-8333-333333333333',
          label: 'Sales',
          owner_type: 'project',
          is_default: true,
        },
      ],
      default_account: 'Sales',
    },
  ],
};

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/v1/connectors/projects/${PROJECT_ID}/catalog`) {
        return Response.json(CATALOG);
      }
      if (
        url.pathname === `/v1/connectors/projects/${PROJECT_ID}/connectors/gmail-ffiod0/accounts`
      ) {
        return Response.json({ connector: 'gmail-ffiod0', accounts: GMAIL_ACCOUNTS });
      }
      return new Response('not found', { status: 404 });
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

async function callMcpTool(name: string, args: Record<string, unknown>) {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
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

describe('MCP meta-tools surface that a connector can hold several accounts', () => {
  test('connectors: per-connector accounts, default_account, and how_to_choose when >1', async () => {
    const { payload, isError } = await callMcpTool('connectors', {});
    expect(isError).toBe(false);
    const connectors = payload.connectors as Array<Record<string, unknown>>;
    const gmail = connectors.find((c) => c.slug === 'gmail-ffiod0')!;
    expect(gmail.accounts).toEqual([
      {
        label: 'marko@kortix.ai',
        owner: 'private',
        default: true,
        connection_id: '22222222-2222-4222-8222-222222222222',
      },
      {
        label: 'markokraemer.mail@gmail.com',
        owner: 'private',
        default: false,
        connection_id: '11111111-1111-4111-8111-111111111111',
      },
    ]);
    expect(gmail.default_account).toBe('marko@kortix.ai');
    expect(gmail.how_to_choose).toBe(
      'call {connector: "gmail-ffiod0", action: "<action>", account: "marko@kortix.ai"}',
    );

    // Stripe has exactly one account — no nudge needed, nothing to choose.
    const stripe = connectors.find((c) => c.slug === 'stripe')!;
    expect(stripe.accounts).toHaveLength(1);
    expect(stripe.accounts).toEqual([
      { label: 'Sales', owner: 'shared', default: true, connection_id: '33333333-3333-4333-8333-333333333333' },
    ]);
    expect(stripe.how_to_choose).toBeUndefined();
  });

  test('describe: carries the same accounts summary for the tool\'s connector', async () => {
    const { payload, isError } = await callMcpTool('describe', { tool: 'gmail-ffiod0.get_profile' });
    expect(isError).toBe(false);
    expect(payload.tool).toBe('gmail-ffiod0.get_profile');
    expect(payload.accounts).toHaveLength(2);
    expect(payload.default_account).toBe('marko@kortix.ai');
    expect(payload.how_to_choose).toBe(
      'call {connector: "gmail-ffiod0", action: "<action>", account: "marko@kortix.ai"}',
    );
  });

  test('accounts tool description tells the model WHEN to use it, before it is invoked', async () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'connectors', 'mcp'],
      cwd: CLI_ROOT,
      env: cliEnv(),
      stdin: new TextEncoder().encode(`${requests}\n`),
      stdout: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const response = stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .find((entry) => entry.id === 2);
    const tools = response.result.tools as Array<{ name: string; description: string }>;
    const accountsTool = tools.find((t) => t.name === 'accounts')!;
    expect(accountsTool.description.startsWith('Use this whenever the human asks')).toBe(true);
    expect(accountsTool.description).toContain('Never infer accounts from a profile/whoami call');
    expect(accountsTool.description).toContain('account_required');

    const callTool = tools.find((t) => t.name === 'call')!;
    expect(callTool.description).toContain('account_required');
    expect(callTool.description).toContain('`account` names WHICH connected account actually ran');
  });
});
