import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  SPILL_THRESHOLD_BYTES,
  jsonShape,
  spillLargeResult,
} from '../connector-gateway/result-spill';

/**
 * A large connector result must reach the model as a path plus a summary.
 *
 * OpenCode truncates every tool output above 50 KB / 2000 lines and hands the
 * model only the head ("...N bytes truncated..."). A Linear list query
 * returned ~93 KB, so the model saw a cut-off JSON document and improvised.
 * The MCP `call` tool now saves a result above SPILL_THRESHOLD_BYTES to a file
 * and returns its shape, and `kortix connectors call --out <file>` does the
 * same on request.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT_ID = 'proj-test-1234';

/** A Linear-style GraphQL page: 400 issues ≈ 90 KB pretty-printed. */
function issuesPage(count: number) {
  return {
    ok: true,
    status: 'ok',
    risk: 'read',
    account: { label: 'Work', owner: 'project' },
    data: {
      issues: {
        nodes: Array.from({ length: count }, (_, i) => ({
          id: `issue-${i}`,
          identifier: `ENG-${i}`,
          title: `Synthetic issue number ${i} with a reasonably long title`,
          state: { name: 'Todo' },
        })),
        pageInfo: { hasNextPage: true, endCursor: 'cursor-400' },
      },
    },
  };
}

describe('jsonShape', () => {
  test('lists keys, array lengths with item keys, and pageInfo verbatim', () => {
    expect(jsonShape(issuesPage(3).data)).toEqual({
      issues: {
        nodes: 'array(3) of {id,identifier,title,state}',
        pageInfo: { hasNextPage: true, endCursor: 'cursor-400' },
      },
    });
  });

  test('keeps numbers and booleans, types strings, and names scalar arrays', () => {
    expect(jsonShape({ total: 312, more: false, name: 'x', ids: [1, 2], empty: [], none: null })).toEqual({
      total: 312,
      more: false,
      name: 'string',
      ids: 'array(2) of number',
      empty: 'array(0)',
      none: null,
    });
  });

  test('caps object keys so an id-keyed map cannot blow up the summary', () => {
    const map = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    const shape = jsonShape(map) as Record<string, unknown>;
    expect(Object.keys(shape)).toHaveLength(41);
    expect(shape['…']).toBe('60 more keys');
  });

  test('stops descending past depth 4', () => {
    expect(jsonShape({ a: { b: { c: { d: { e: 1, f: 2 } } } } })).toEqual({
      a: { b: { c: { d: '{e,f}' } } },
    });
  });
});

describe('spillLargeResult', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'kortix-spill-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('a result at or under the threshold is returned untouched', async () => {
    const small = issuesPage(2);
    expect(JSON.stringify(small, null, 2).length).toBeLessThan(SPILL_THRESHOLD_BYTES);
    expect(await spillLargeResult(small, { connector: 'linear', action: 'issues', workspaceRoot: root })).toBe(small);
    expect(readdirSync(root)).toEqual([]);
  });

  test('a large result is saved in full and replaced by a compact summary', async () => {
    const big = issuesPage(400);
    const text = JSON.stringify(big, null, 2);
    expect(text.length).toBeGreaterThan(80_000);

    const compact = (await spillLargeResult(big, {
      connector: 'linear',
      action: 'graphql.issues',
      workspaceRoot: root,
    })) as Record<string, unknown>;

    const dir = join(root, '.kortix', 'state', 'connector-results');
    expect(compact.saved_to).toStartWith(`${dir}/`);
    expect(compact.saved_to).toMatch(/-linear-graphql\.issues-[0-9a-f]{8}\.json$/);
    expect(JSON.parse(readFileSync(compact.saved_to as string, 'utf8'))).toEqual(big);
    expect(compact.bytes).toBe(Buffer.byteLength(text));
    // The envelope survives; only `data` is replaced.
    expect(compact).toMatchObject({ ok: true, status: 'ok', risk: 'read', account: big.account });
    expect(compact.data).toBeUndefined();
    expect(compact.shape).toEqual({
      issues: {
        nodes: 'array(400) of {id,identifier,title,state}',
        pageInfo: { hasNextPage: true, endCursor: 'cursor-400' },
      },
    });
    expect((compact.preview as string).length).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(big)).toStartWith(compact.preview as string);
    expect(compact.hint).toContain(`jq`);
    expect(compact.hint).toContain(compact.saved_to as string);
    expect(JSON.stringify(compact).length).toBeLessThan(4096);
    // The results dir ignores itself so a spill never dirties the git tree.
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  test('an unwritable root falls back to the full inline result', async () => {
    const big = issuesPage(400);
    const result = await spillLargeResult(big, {
      connector: 'linear',
      action: 'issues',
      workspaceRoot: '/dev/null/not-a-dir',
    });
    expect(result).toBe(big);
  });
});

describe('real processes against a stub gateway', () => {
  let server: ReturnType<typeof Bun.serve>;
  let workspace: string;
  let payload: unknown;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'kortix-spill-ws-'));
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
    });
  });
  afterAll(() => {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  function env(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      KORTIX_TOKEN: 'session-agent-token',
      KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
      KORTIX_PROJECT_ID: PROJECT_ID,
      KORTIX_INTERNAL_WORKSPACE_ROOT: workspace,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };
  }

  async function run(cmd: string[], stdin?: string) {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, ...cmd],
      cwd: CLI_ROOT,
      env: env(),
      stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  test('CLI: call --out writes the full result and prints a summary', async () => {
    payload = issuesPage(400);
    const file = join(workspace, 'nested', 'dir', 'issues.json');

    const { code, stdout, stderr } = await run([
      'connectors', 'call', 'linear', 'issues', '{"first":400}', '--out', file, '--project', PROJECT_ID,
    ]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(payload);
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({
      ok: true,
      saved_to: file,
      bytes: Buffer.byteLength(JSON.stringify(payload, null, 2)),
      shape: { issues: { nodes: 'array(400) of {id,identifier,title,state}' } },
    });
    expect(summary.data).toBeUndefined();
    expect(stdout.length).toBeLessThan(2048);
  });

  test('CLI: call --out without a path is a usage error', async () => {
    payload = issuesPage(1);
    const { code, stdout } = await run(['connectors', 'call', 'linear.issues', '--out', '--project', PROJECT_ID]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'USAGE' });
  });

  test('CLI: call without --out prints the full result as before', async () => {
    payload = issuesPage(400);
    const { code, stdout } = await run(['connectors', 'call', 'linear.issues', '--project', PROJECT_ID]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(payload);
  });

  async function mcpCall() {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'call', arguments: { connector: 'linear', action: 'issues' } },
      },
    ];
    const { stdout } = await run(
      ['connectors', 'mcp'],
      `${requests.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const response = stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .find((entry) => entry.id === 2);
    return {
      text: response.result.content[0].text as string,
      isError: response.result.isError as boolean,
    };
  }

  test('MCP: a large call result comes back as saved_to + shape + preview', async () => {
    payload = issuesPage(400);
    const { text, isError } = await mcpCall();

    expect(isError).toBe(false);
    expect(text.length).toBeLessThan(4096);
    const compact = JSON.parse(text);
    expect(compact.saved_to).toStartWith(join(workspace, '.kortix', 'state', 'connector-results'));
    expect(JSON.parse(readFileSync(compact.saved_to, 'utf8'))).toEqual(payload);
    expect(compact.shape.issues.nodes).toBe('array(400) of {id,identifier,title,state}');
  });

  test('MCP: a small call result is returned inline, unchanged', async () => {
    payload = issuesPage(2);
    const { text, isError } = await mcpCall();
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual(payload);
  });
});
