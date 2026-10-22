import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let searched: URL[] = [];

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/capture/me/search') {
        searched.push(url);
        return Response.json({ user_id: 'user_1', q: url.searchParams.get('q'), hits: [] });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  const configFile = join(tmp, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: `http://127.0.0.1:${server.port}`,
          token: 'tok_capture',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return configFile;
}

async function runCli(args: string[], configFile: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: tmp, env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix capture search', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-capture-search-'));
    searched = [];
  });
  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  // KRTX-2983: --day was parsed and validated, then dropped, so a one-day
  // search returned hits from all time.
  test('--day keeps the search to that UTC day', async () => {
    const config = startServer();
    const r = await runCli(['capture', 'search', 'invoice', '--day', '2026-10-20', '--json'], config);
    expect(r.code).toBe(0);
    expect(searched.map((u) => u.searchParams.get('day'))).toEqual(['2026-10-20']);
  });

  test('--help names --day for search', async () => {
    const config = startServer();
    const r = await runCli(['capture', '--help'], config);
    expect(r.stdout).toMatch(/--day <date>\s+search, timeline:/);
  });
});
