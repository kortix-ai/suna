import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'agents_project';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_agents',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

function startServer(detail?: unknown): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (detail !== undefined && new URL(req.url).pathname.endsWith('/detail')) {
        return Response.json(detail);
      }
      return Response.json({
        platformDefault: null,
        accountDefault: null,
        projectDefault: null,
        agentDefaults: detail === undefined ? {} : { reviewer: 'glm-5.3-flash' },
        resolvedForCaller: null,
      });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

const DETAIL = {
  project_id: PROJECT,
  config: {
    default_agent: 'kortix',
    agents: [
      { name: 'meta', path: '/workspace/AGENTS.md', description: 'Talks with you.', mode: 'primary' },
      { name: 'kortix', path: 'a.md', description: 'General project work.', mode: 'primary' },
      { name: 'reviewer', path: 'b.md', description: 'Reviews pull requests.', mode: 'primary' },
      { name: 'helper', path: 'c.md', description: 'Internal helper.', mode: 'subagent' },
      { name: 'old', path: 'd.md', description: 'Retired.', mode: 'primary', enabled: false },
    ],
  },
};

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of [
    'KORTIX_API_URL',
  'KORTIX_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix agents command', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-agents-command-'));
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('help describes concrete defaults without exposing the removed Auto model', async () => {
    const result = await runCli(['agents', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('explicit concrete model');
    expect(result.stdout.toLowerCase()).not.toContain('auto');
  });

  test('models does not invent Auto when a malformed server omits every default', async () => {
    const config = writeConfig(startServer());
    const result = await runCli(
      ['agents', 'models', '--project', PROJECT],
      config,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('unavailable');
    expect(result.stdout.toLowerCase()).not.toContain('auto');
  });

  test('ls lists every launchable agent with its description for routing', async () => {
    const config = writeConfig(startServer(DETAIL));
    const result = await runCli(['agents', 'ls', '--project', PROJECT], config);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/kortix\s+default\s+General project work\./);
    expect(result.stdout).toMatch(/reviewer\s+glm-5\.3-flash\s+Reviews pull requests\./);
    // The platform agent, subagents and disabled agents are not routing targets.
    expect(result.stdout).not.toContain('Talks with you.');
    expect(result.stdout).not.toContain('Internal helper.');
    expect(result.stdout).not.toContain('Retired.');
  });

  test('ls --json keeps the model-defaults keys and adds the agents', async () => {
    const config = writeConfig(startServer(DETAIL));
    const result = await runCli(['agents', 'ls', '--project', PROJECT, '--json'], config);
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.agentDefaults).toEqual({ reviewer: 'glm-5.3-flash' });
    expect(out.agents).toEqual([
      { name: 'kortix', description: 'General project work.', default: true, model: null },
      { name: 'reviewer', description: 'Reviews pull requests.', default: false, model: 'glm-5.3-flash' },
    ]);
  });
});
