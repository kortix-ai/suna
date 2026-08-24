import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The root help promises `kortix <cmd> <subcommand> --help`. This asserts the
// promise for EVERY group command and EVERY subcommand its own `--help` block
// advertises: help prints, exit code is 0, and nothing reaches auth, project
// resolution, or the network first.
//
// The matrix is generated, not hand-written — a new subcommand documented in a
// group's help is covered the moment it is added.

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };

const GROUPS = [
  'access',
  'accounts',
  'agents',
  'apps',
  'audit',
  'billing',
  'channels',
  'connectors',
  'cr',
  'env',
  'files',
  'gateway',
  'grants',
  'groups',
  'hosts',
  'marketplace',
  'members',
  'models',
  'permissions',
  'projects',
  'providers',
  'review',
  'roles',
  'sandboxes',
  'secrets',
  'sessions',
  'tokens',
  'triggers',
] as const;

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let apiBase = '';
let requests: string[] = [];

function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    // A path that does not exist: the CLI is NOT logged in for this run.
    KORTIX_CONFIG_FILE: join(tmp, 'missing-config.json'),
    // Any HTTP the CLI attempts lands on the recorder, never on a real host.
    KORTIX_API_URL: apiBase,
  };
  for (const key of ['KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(9), 15_000);
  return Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    .finally(() => clearTimeout(timeout))
    .then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
}

/**
 * Collect the subcommand names a group's own `--help` advertises.
 *
 * Entries are 2-space-indented lines inside a titled block; deeper indents are
 * option/continuation lines. Prefer the canonical `Subcommands:` block; a few
 * groups (access, gateway, groups, members, roles, tokens) split their verbs
 * across several titled blocks instead, so fall back to every block that is
 * not options/examples/usage.
 */
function parseSubcommands(help: string): string[] {
  const collect = (strict: boolean): string[] => {
    const subs: string[] = [];
    let inBlock = false;
    for (const line of help.split('\n')) {
      if (line.trim() === '') {
        inBlock = false;
        continue;
      }
      const header = /^ {2}(\S.*):\s*$/.exec(line);
      if (header) {
        const title = header[1].toLowerCase();
        inBlock = strict
          ? title === 'subcommands'
          : !(title.includes('option') || title.includes('example') || title.includes('usage'));
        continue;
      }
      if (!inBlock) continue;
      const entry = /^ {2}([a-z][a-z0-9-]*)(\s|$)/.exec(line);
      if (entry && entry[1] !== 'kortix') subs.push(entry[1]);
    }
    return [...new Set(subs)];
  };
  const strict = collect(true);
  return strict.length > 0 ? strict : collect(false);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

describe('kortix <group> <subcommand> --help', () => {
  beforeAll(() => {
    process.env = { ...ORIGINAL_ENV };
    tmp = mkdtempSync(join(tmpdir(), 'kortix-leaf-help-'));
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        requests.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ error: 'the help path must never reach the API' }, { status: 500 });
      },
    });
    apiBase = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  for (const group of GROUPS) {
    test(`${group}: every documented subcommand prints help, exit 0, no auth, no HTTP`, async () => {
      const before = requests.length;
      const groupHelp = await runCli([group, '--help']);
      expect(groupHelp.code).toBe(0);
      expect(groupHelp.stdout).toContain(`Usage: kortix ${group}`);

      const subs = parseSubcommands(groupHelp.stdout);
      expect(subs.length).toBeGreaterThan(0);

      const results = await mapWithConcurrency(subs, 4, async (sub) => ({
        sub,
        ...(await runCli([group, sub, '--help'])),
      }));

      for (const r of results) {
        const where = `kortix ${group} ${r.sub} --help`;
        expect(`${where} exit=${r.code}`).toBe(`${where} exit=0`);
        expect(`${where} :: ${r.stdout}`).toContain('Usage:');
        // The banner on stderr says "not logged in" (lowercase); these are the
        // error forms that mean auth/project resolution ran before the help.
        expect(`${where} :: ${r.stderr}`).not.toContain('Not logged in');
        expect(`${where} :: ${r.stderr}`).not.toContain('No project');
      }

      expect(requests.slice(before)).toEqual([]);
    }, 30_000);
  }
});
