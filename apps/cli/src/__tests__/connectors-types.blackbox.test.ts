import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * `kortix connectors types` driven as a real CLI process against a stub API:
 * the request it sends, the declaration file it writes, and that the file
 * type-checks a consumer against the real `@kortix/sdk` registry (good args
 * compile, bad args and a wrong result shape do not).
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const SDK_ENTRY = resolve(CLI_ROOT, '..', '..', 'packages', 'sdk', 'src', 'index.ts');
const TSC = join(CLI_ROOT, 'node_modules', '.bin', 'tsc');
const PROJECT_ID = 'proj-connector-types';

const CATALOG = {
  connectors: [
    {
      slug: 'ke2e-tracker',
      name: 'Tracker',
      provider: 'openapi',
      status: 'active',
      actions: [
        {
          path: 'list_issues',
          name: 'List issues',
          description: 'List issues of one team',
          risk: 'read',
          inputSchema: {
            type: 'object',
            properties: {
              team: { type: 'string', description: 'Team key, e.g. CORE' },
              state: { type: 'string', enum: ['open', 'closed'] },
              limit: { type: 'integer' },
            },
            required: ['team'],
          },
          outputSchema: {
            type: 'object',
            properties: {
              issues: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'string' }, title: { type: 'string', nullable: true } },
                  required: ['id'],
                },
              },
              'next-cursor': { type: ['string', 'null'] },
            },
            required: ['issues'],
          },
        },
      ],
    },
    {
      slug: 'ke2e-mcp',
      name: 'MCP',
      provider: 'mcp',
      status: 'active',
      actions: [
        {
          path: 'get_issue',
          name: 'get_issue',
          description: 'Get one issue',
          risk: 'read',
          inputSchema: {
            type: 'object',
            properties: { ref: { $ref: '#/$defs/Ref' } },
            required: ['ref'],
            $defs: { Ref: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
          },
          outputSchema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
        },
      ],
    },
    {
      slug: 'ke2e-managed',
      name: 'Managed',
      provider: 'composio',
      status: 'active',
      actions: [
        {
          path: 'send',
          name: 'Send',
          description: 'Send a message',
          risk: 'write',
          inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
          outputSchema: null,
        },
      ],
    },
  ],
};

let server: ReturnType<typeof Bun.serve>;
const searches: string[] = [];
let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kortix-connector-types-'));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== `/v1/connectors/projects/${PROJECT_ID}/catalog`) {
        return new Response('not found', { status: 404 });
      }
      searches.push(url.search);
      const slug = url.searchParams.get('slug');
      return Response.json({
        connectors: slug ? CATALOG.connectors.filter((c) => c.slug === slug) : CATALOG.connectors,
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(workdir, { recursive: true, force: true });
});

async function kortix(args: string[], sub = 'types') {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'connectors', sub, ...args],
    cwd: workdir,
    env: {
      ...(process.env as Record<string, string>),
      KORTIX_TOKEN: 'synthetic-token',
      KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
      KORTIX_PROJECT_ID: PROJECT_ID,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe('kortix connectors types', () => {
  test('--out writes the registry declaration and asks for input and output schemas', async () => {
    searches.length = 0;
    const r = await kortix(['--out', 'types/kortix-connectors.d.ts']);
    expect(r.exitCode).toBe(0);
    expect(searches).toEqual(['?include_schemas=true&include_output_schemas=true']);
    expect(r.stdout).toContain('Wrote 3 actions across 3 connectors to types/kortix-connectors.d.ts');
    expect(r.stdout).toContain('No output schema (result is unknown): ke2e-managed');

    const file = readFileSync(join(workdir, 'types/kortix-connectors.d.ts'), 'utf8');
    expect(file).toContain("declare module '@kortix/sdk' {");
    expect(file).toContain('  interface ConnectorActionRegistry {');
    expect(file).toContain('"ke2e-tracker": {');
    expect(file).toContain('/** [read] List issues of one team */');
    expect(file).toContain('/** Team key, e.g. CORE */');
    expect(file).toContain('team: string;');
    expect(file).toContain('state?: "open" | "closed";');
    expect(file).toContain('title?: string | null;');
    expect(file).toContain('"next-cursor"?: string | null;');
    expect(file).toContain('ref: string | number;');
    expect(file).toContain('ok: true;');
    expect(file).toMatch(/send: \{\n\s+args: \{\n\s+to: string;\n\s+\};\n\s+result: unknown;/);
  });

  test('the generated file type-checks a consumer against the real SDK registry', async () => {
    writeFileSync(
      join(workdir, 'use.ts'),
      `import { createKortix, type ConnectorResult } from '@kortix/sdk';
const connectors = createKortix({ backendUrl: 'http://x/v1', getToken: async () => null }).project('p').connectors;
export async function run() {
  const listed = await connectors.callAction('ke2e-tracker', 'list_issues', { team: 'CORE', state: 'open' });
  const id: string | undefined = listed.output?.issues[0]?.id;
  // @ts-expect-error team is required
  await connectors.callAction('ke2e-tracker', 'list_issues', { state: 'open' });
  // @ts-expect-error state accepts only the enum values
  await connectors.callAction('ke2e-tracker', 'list_issues', { team: 'CORE', state: 'stale' });
  // @ts-expect-error an unknown argument is rejected
  await connectors.callAction('ke2e-tracker', 'list_issues', { team: 'CORE', bogus: 1 });
  await connectors.callAction('ke2e-mcp', 'get_issue', { ref: 7 });
  const sent = await connectors.callAction('ke2e-managed', 'send', { to: 'a' });
  const opaque: unknown = sent.output;
  // @ts-expect-error a typed output keeps its shape
  const wrong: ConnectorResult<'ke2e-tracker', 'list_issues'> = { issues: 'none' };
  return [id, opaque, wrong];
}
`,
    );
    writeFileSync(
      join(workdir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          jsx: 'react-jsx',
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          // The SDK sources reference Bun/Node globals; a consumer gets them from its own runtime types.
          typeRoots: [resolve(CLI_ROOT, '..', '..', 'node_modules', '@types')],
          types: ['bun'],
          paths: { '@kortix/sdk': [SDK_ENTRY] },
        },
        files: ['types/kortix-connectors.d.ts', 'use.ts'],
      }),
    );
    const proc = Bun.spawn({ cmd: [TSC, '-p', workdir], cwd: workdir, stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(proc.stdout).text();
    expect(output).toBe('');
    expect(await proc.exited).toBe(0);
  }, 120_000);

  test('--connector reads one connector per slug and prints to stdout', async () => {
    searches.length = 0;
    const r = await kortix(['--connector', 'ke2e-mcp']);
    expect(r.exitCode).toBe(0);
    expect(searches).toEqual(['?slug=ke2e-mcp&include_schemas=true&include_output_schemas=true']);
    expect(r.stdout.startsWith('// Generated by `kortix connectors types`')).toBe(true);
    expect(r.stdout).toContain('"ke2e-mcp": {');
    expect(r.stdout).not.toContain('ke2e-tracker');
  });

  test('an unknown --connector slug exits 1 and names it', async () => {
    const r = await kortix(['--connector', 'ke2e-mcp,ke2e-missing']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No callable connector: ke2e-missing');
    expect(r.stdout).toBe('');
  });

  test('show <slug>.<action> prints the output schema when the connector publishes one', async () => {
    const typed = await kortix(['ke2e-tracker.list_issues'], 'show');
    expect(typed.exitCode).toBe(0);
    expect(JSON.parse(typed.stdout).outputSchema.required).toEqual(['issues']);
    const managed = await kortix(['ke2e-managed.send'], 'show');
    expect(managed.exitCode).toBe(0);
    expect('outputSchema' in JSON.parse(managed.stdout)).toBe(false);
  });
});
