import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

/**
 * Characterization of the `connectors mcp` error envelopes, captured BEFORE
 * the KRTX-1341 module split collapses the seven identical plain-error
 * catches into one boundary.
 *
 * Three classes are pinned here:
 *  1. argument-validation errors — exact `{ ok, error }` strings, returned
 *     before any network call;
 *  2. plain tool errors — a thrown gateway error reaches the model as
 *     `{ ok: false, error }` and NOTHING else (no `code`, no `reason`);
 *  3. structured errors — `call` (and `upload_attachment`) hand the API body
 *     back verbatim and add `code: "CONNECTOR_ERROR"` only when the body
 *     names no `reason` of its own.
 *
 * After the refactor every class must be byte for byte the same.
 */
const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

const rpc = (id: unknown, method: string, params: unknown = {}) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

async function runMcp(stdin: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'connectors', 'mcp'],
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      KORTIX_TOKEN: 'test-token-not-used-offline',
      // A port with no listener: every gateway call throws fast, offline.
      KORTIX_API_URL: 'http://127.0.0.1:9/v1',
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      // The hermetic suite's fresh config store — the spawned CLI inherits nothing.
      KORTIX_CONFIG_FILE: process.env.KORTIX_CONFIG_FILE,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]).finally(
    () => clearTimeout(timer),
  );
  const responses = stdout
    .split('\n')
    .filter((line) => line.trim())
    .map(
      (line) =>
        JSON.parse(line) as {
          id: unknown;
          result?: { isError?: boolean; content?: Array<{ text?: string }> };
        },
    );
  const payload = (index: number): Record<string, unknown> => {
    const text = responses[index]?.result?.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error(`no tool payload at response ${index}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  // Exactly one tools/call per run → its decoded payload.
  const first = (): Record<string, unknown> => payload(0);
  return { code, responses, payload, first };
}

const callOne = (name: string, args: Record<string, unknown>) =>
  runMcp(rpc(1, 'tools/call', { name, arguments: args })).then(({ first }) => ({ first }));

describe('connectors mcp — error envelope characterization (KRTX-1341)', () => {
  test('every argument-validation error answers its exact message (batched over one server run)', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['describe', {}, 'tool must be a "<connector>.<action>" path'],
      ['describe', { tool: 'nosuchpath' }, 'tool must be a "<connector>.<action>" path'],
      ['call', {}, 'connector and action are required'],
      ['call', { connector: 'crm' }, 'connector and action are required'],
      ['upload_attachment', {}, 'connector is required'],
      ['accounts', {}, 'connector is required'],
      ['connect', {}, 'slug is required'],
      ['connect', { slug: 'x', owner: 'everyone' }, 'owner must be "me" or "project"'],
      ['finalize_connection', {}, 'slug is required'],
      ['request_secret', {}, 'names is required'],
      ['request_secret', { names: [] }, 'names is required'],
      ['set_secret', {}, 'values is required'],
      ['set_secret', { values: { K: '' } }, 'values is required'],
      ['secret_call', {}, 'identifier and url are required'],
      ['add_connector', {}, 'slug and provider are required'],
      ['remove_connector', {}, 'slug is required'],
    ];
    // One server process for the whole matrix — each tools/call is an
    // independent request, so batching changes nothing on the wire.
    const stdin = cases
      .map(([name, args], i) => rpc(i + 1, 'tools/call', { name, arguments: args }))
      .join('');
    const { responses, payload } = await runMcp(stdin);
    expect(responses).toHaveLength(cases.length);
    cases.forEach(([name, args, message], i) => {
      expect(payload(i), `${name} ${JSON.stringify(args)}`).toEqual({ ok: false, error: message });
    });
  });

  test('legacy Pipedream is refused before any network call', async () => {
    const { first } = await callOne('add_connector', { slug: 'x', provider: 'pipedream' });
    const payload = first();
    expect((payload.error as string).startsWith('Pipedream is legacy rollback only')).toBe(true);
    expect(payload).toEqual({ ok: false, error: payload.error });
  });

  test('a thrown gateway error on a plain tool is { ok, error } and nothing else', async () => {
    const { first } = await callOne('remove_connector', { slug: 'x' });
    const payload = first();
    expect(Object.keys(payload).sort()).toEqual(['error', 'ok']);
    expect(payload.ok).toBe(false);
    expect(typeof payload.error).toBe('string');
    expect((payload.error as string).length).toBeGreaterThan(0);
  });

  test('the same thrown error through `call` and `upload_attachment` keeps the structured envelope with the generic code', async () => {
    const callRun = await runMcp(
      rpc(1, 'tools/call', { name: 'call', arguments: { connector: 'crm', action: 'whoami' } }) +
        rpc(2, 'tools/call', {
          name: 'upload_attachment',
          arguments: { connector: 'crm', path: '/workspace/output/x.pdf' },
        }),
    );
    // No API body reached the error, so connectorErrorPayload adds its generic
    // code — exactly the field the plain envelope must NOT grow.
    for (const index of [0, 1]) {
      const payload = callRun.payload(index);
      expect(Object.keys(payload).sort()).toEqual(['code', 'error', 'ok']);
      expect(payload.code).toBe('CONNECTOR_ERROR');
    }
  });
});
