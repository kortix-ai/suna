import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * Black-box tests for the `secret_call` MCP tool.
 *
 * Driven through the real stdio server against a stub API, rather than by
 * importing the handler and mocking `../connector-gateway/gateway`. Module
 * mocks in this repo leak across co-run suites (a `mock.module` on a barrel
 * replaces it wholesale), and the thing worth proving here is the wire
 * contract anyway: what the tool sends to the broker route, and what it hands
 * back to the model.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT_ID = 'proj-test-1234';

interface Captured {
  path: string;
  body: Record<string, unknown>;
  auth: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let captured: Captured[] = [];
/** Set per-test to control what the stub broker returns. */
let respondWith: () => Response;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      captured.push({
        path: url.pathname,
        body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
        auth: req.headers.get('authorization'),
      });
      return respondWith();
    },
  });
});

afterAll(() => server.stop(true));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function callTool(args: Record<string, unknown>) {
  captured = [];
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'secret_call', arguments: args },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');

  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'connectors', 'mcp'],
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      KORTIX_TOKEN: 'session-agent-token',
      KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
      KORTIX_PROJECT_ID: PROJECT_ID,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdin: new TextEncoder().encode(`${requests}\n`),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  const lines = stdout.split('\n').filter((line) => line.trim());
  const toolResponse = lines.map((line) => JSON.parse(line)).find((entry) => entry.id === 2);
  if (!toolResponse) throw new Error(`no tool response. stdout=${stdout} stderr=${stderr}`);
  return {
    raw: toolResponse,
    payload: JSON.parse(toolResponse.result.content[0].text) as Record<string, unknown>,
    isError: toolResponse.result.isError === true,
  };
}

describe('secret_call MCP tool', () => {
  test('posts to the broker route and never carries the credential', async () => {
    respondWith = () =>
      jsonResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body_base64: Buffer.from(JSON.stringify({ ok: true, id: 'ch_1' })).toString('base64'),
      });

    const result = await callTool({
      identifier: 'STRIPE_KEY',
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"amount":100}',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe(`/v1/projects/${PROJECT_ID}/secrets/STRIPE_KEY/broker`);
    expect(captured[0].body.url).toBe('https://api.stripe.com/v1/charges');
    expect(captured[0].body.method).toBe('POST');
    // Header names are lowercased so a model passing "Content-Type" cannot
    // collide with the credential header the API injects.
    expect(captured[0].body.headers).toEqual({ 'content-type': 'application/json' });
    expect(Buffer.from(captured[0].body.body_base64 as string, 'base64').toString('utf8')).toBe(
      '{"amount":100}',
    );

    // The tool decodes a JSON content-type into text the model can read.
    expect(result.isError).toBe(false);
    expect(result.payload.status).toBe(200);
    expect(result.payload.body).toBe('{"ok":true,"id":"ch_1"}');
    expect(result.payload.body_base64).toBeUndefined();
  });

  test('surfaces an upstream 4xx as a real answer, not a tool failure', async () => {
    respondWith = () =>
      jsonResponse({
        status: 401,
        headers: { 'content-type': 'application/json' },
        body_base64: Buffer.from('{"error":"bad key"}').toString('base64'),
      });

    const result = await callTool({ identifier: 'STRIPE_KEY', url: 'https://api.stripe.com/v1/me' });

    // isError would make most clients hide the body; the model needs to read
    // the 401 to decide whether to re-request the credential.
    expect(result.isError).toBe(false);
    expect(result.payload.status).toBe(401);
    expect(result.payload.body).toBe('{"error":"bad key"}');
  });

  test('returns base64 for non-text upstream bodies instead of mangling them', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    respondWith = () =>
      jsonResponse({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body_base64: png.toString('base64'),
      });

    const result = await callTool({ identifier: 'MAPS_KEY', url: 'https://api.example.com/tile' });

    expect(result.payload.body).toBeUndefined();
    expect(result.payload.body_base64).toBe(png.toString('base64'));
  });

  test('rejects a plaintext URL before it reaches the API', async () => {
    respondWith = () => jsonResponse({}, 500);

    const result = await callTool({ identifier: 'STRIPE_KEY', url: 'http://api.stripe.com/v1/me' });

    // An http:// hop would put the injected credential on the wire in clear.
    expect(result.isError).toBe(true);
    expect(String(result.payload.error)).toContain('HTTPS');
    expect(captured).toHaveLength(0);
  });

  test('requires both identifier and url', async () => {
    respondWith = () => jsonResponse({}, 500);

    const result = await callTool({ url: 'https://api.stripe.com/v1/me' });

    expect(result.isError).toBe(true);
    expect(captured).toHaveLength(0);
  });

  test('sends only the identifier — the request carries no credential field', async () => {
    // The confidentiality property the broker provides: the guest names a
    // secret, it never holds or transmits one. An upstream that echoes the
    // credential back is handled server-side by `redactSecretFromResponse`
    // (apps/api/src/secrets/http-broker.ts) — out of scope for this tool test,
    // which only proves the request side.
    respondWith = () =>
      jsonResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body_base64: Buffer.from('{"ok":true}').toString('base64'),
      });

    await callTool({
      identifier: 'STRIPE_KEY',
      url: 'https://api.stripe.com/v1/me',
      headers: { accept: 'application/json' },
    });

    expect(Object.keys(captured[0].body).sort()).toEqual(['headers', 'url']);
    expect(captured[0].body.headers).toEqual({ accept: 'application/json' });
    // The only bearer on the wire is the session's own token, not the secret.
    expect(captured[0].auth).toBe('Bearer session-agent-token');
  });
});
