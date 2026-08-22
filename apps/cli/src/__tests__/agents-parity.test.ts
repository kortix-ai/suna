import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_agents';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Array<{ method: string; path: string; body: unknown }> = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_agents_parity',
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

/** GET /projects/:id/agents/reviewer/config (agent-config.ts:198). */
const REVIEWER_BLOCK = {
  enabled: true,
  sandbox: 'node22',
  connectors: ['slack'],
  connectors_required: [],
  secrets: 'all',
  skills: 'all',
  kortix_cli: 'all',
  workspace: 'runtime',
  opencode: { description: 'Reviews diffs', mode: 'primary', prompt: 'You review code.' },
};

function startServer(): string {
  let defaultAgent = 'default';
  const agentModelPins: Record<string, string> = {};
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json();
      calls.push({ method: req.method, path: url.pathname, body });
      const p = url.pathname.replace(`/v1/projects/${PROJECT}`, '');

      if (p === '/detail' && req.method === 'GET') {
        return Response.json({
          project_id: PROJECT,
          config: {
            default_agent: defaultAgent,
            agents: [
              { name: 'default', path: '.kortix/opencode/agents/default.md', description: null, mode: 'primary' },
              { name: 'reviewer', path: '.kortix/opencode/agents/reviewer.md', description: 'Reviews diffs', mode: 'primary' },
            ],
          },
        });
      }
      if (p === '/default-agent' && req.method === 'PUT') {
        const wanted = (body as { agent: string }).agent;
        if (wanted === 'ghost') {
          return Response.json(
            { error: 'Agent "ghost" is not declared', code: 'invalid_config' },
            { status: 400 },
          );
        }
        defaultAgent = wanted;
        return Response.json({ ok: true, default_agent: wanted });
      }
      if (p === '/agents/reviewer/config' && req.method === 'GET') {
        return Response.json({
          agent: 'reviewer',
          schema_version: 2,
          editable: true,
          default_agent: defaultAgent,
          block: REVIEWER_BLOCK,
        });
      }
      if (p === '/agents/reviewer/config' && req.method === 'PUT') {
        return Response.json({
          ok: true,
          agent: 'reviewer',
          schema_version: 2,
          block: body,
        });
      }
      if (p === '/agents/reviewer/scope' && req.method === 'PUT') {
        const b = body as Record<string, unknown>;
        return Response.json({
          ok: true,
          agent: 'reviewer',
          env: b.env ?? 'all',
          connectors: b.connectors ?? [],
          connectors_required: b.connectors_required ?? [],
        });
      }
      if (p === '/agents/ghost/scope' && req.method === 'PUT') {
        return Response.json(
          { error: 'Agent "ghost" is not declared in this project', code: 'agent_not_found' },
          { status: 404 },
        );
      }
      if (p === '/model-defaults' && req.method === 'GET') {
        return Response.json({
          platformDefault: 'glm-5.2',
          accountDefault: null,
          projectDefault: null,
          agentDefaults: agentModelPins,
          resolvedForCaller: 'glm-5.2',
        });
      }
      if (p === '/model-defaults' && req.method === 'PUT') {
        const b = body as { scope: string; agentName: string; model: string };
        agentModelPins[b.agentName] = b.model;
        return Response.json({ ok: true, ...b });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

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
    'KORTIX_CLI_TOKEN',
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
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix agents — default, scope, config', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-agents-parity-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents the subcommands and both permissions', async () => {
    const r = await runCli(['agents', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('default <agent>');
    expect(r.stdout).toContain('scope <agent>');
    expect(r.stdout).toContain('config <agent>');
    expect(r.stdout).toContain('project.agent.write');
    expect(r.stdout).toContain('project.customize.write');
  });

  test('the existing `model` surface is unchanged', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['agents', 'model', 'reviewer', 'glm-5.2', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: `/v1/projects/${PROJECT}/model-defaults`,
      body: { scope: 'agent', agentName: 'reviewer', model: 'glm-5.2' },
    });
    const ls = await runCli(['agents', 'ls', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(ls.stdout).platformDefault).toBe('glm-5.2');
  });

  test('default --show reads the project detail; default <agent> PUTs /default-agent', async () => {
    const config = writeConfig(startServer());
    const show = await runCli(['agents', 'default', '--show', '--project', PROJECT], config);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('default agent  default');
    expect(calls.at(-1)?.path).toBe(`/v1/projects/${PROJECT}/detail`);

    const set = await runCli(['agents', 'default', 'reviewer', '--project', PROJECT], config);
    expect(set.code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: `/v1/projects/${PROJECT}/default-agent`,
      body: { agent: 'reviewer' },
    });
    expect(set.stdout).toContain('Default agent → reviewer');
  });

  test('default surfaces the API 400 for an undeclared agent', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['agents', 'default', 'ghost', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Agent "ghost" is not declared');
  });

  test('scope --show prints the block; a write PUTs only the named fields', async () => {
    const config = writeConfig(startServer());
    const show = await runCli(['agents', 'scope', 'reviewer', '--show', '--project', PROJECT], config);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('secrets              all');
    expect(show.stdout).toContain('connectors           slack');
    expect(calls.at(-1)).toEqual({
      method: 'GET',
      path: `/v1/projects/${PROJECT}/agents/reviewer/config`,
      body: null,
    });

    calls = [];
    const write = await runCli(
      [
        'agents', 'scope', 'reviewer',
        '--secrets', 'none',
        '--connectors', 'slack,github',
        '--require-connector', 'gmail',
        '--project', PROJECT,
      ],
      config,
    );
    expect(write.code).toBe(0);
    // `none` has no literal on this route — it goes out as the empty list.
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: `/v1/projects/${PROJECT}/agents/reviewer/scope`,
        body: { env: [], connectors: ['slack', 'github'], connectors_required: ['gmail'] },
      },
    ]);
    expect(write.stdout).toContain('reviewer scope updated');
  });

  test('scope --secrets all sends the `all` literal, and a missing name exits 2', async () => {
    const config = writeConfig(startServer());
    const all = await runCli(
      ['agents', 'scope', 'reviewer', '--secrets', 'all', '--project', PROJECT],
      config,
    );
    expect(all.code).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ env: 'all' });

    const noName = await runCli(['agents', 'scope', '--secrets', 'all', '--project', PROJECT], config);
    expect(noName.code).toBe(2);
    expect(noName.stderr).toContain('Pass an agent name.');
  });

  test('scope surfaces the 404 for an undeclared agent', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['agents', 'scope', 'ghost', '--connectors', 'slack', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Agent "ghost" is not declared in this project');
  });

  test('config prints the block; --json wraps it with the schema version', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['agents', 'config', 'reviewer', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(REVIEWER_BLOCK);

    const j = await runCli(['agents', 'config', 'reviewer', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(j.stdout).schema_version).toBe(2);
  });

  test('config --set reads the current block first and PUTs the WHOLE merged block', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      [
        'agents', 'config', 'reviewer',
        '--set', 'opencode.model=glm-5.2',
        '--set', 'enabled=false',
        '--project', PROJECT,
      ],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'GET',
      path: `/v1/projects/${PROJECT}/agents/reviewer/config`,
      body: null,
    });
    // The PUT replaces the agent's whole kortix.yaml entry, so everything the
    // GET returned has to come back — only the two named keys differ.
    expect(calls[1]).toEqual({
      method: 'PUT',
      path: `/v1/projects/${PROJECT}/agents/reviewer/config`,
      body: {
        ...REVIEWER_BLOCK,
        enabled: false,
        opencode: { ...REVIEWER_BLOCK.opencode, model: 'glm-5.2' },
      },
    });
    expect(r.stdout).toContain('reviewer config saved');
  });

  test('config --file PUTs the file verbatim without a read-modify-write', async () => {
    const config = writeConfig(startServer());
    const file = join(tmp, 'block.json');
    writeFileSync(file, JSON.stringify({ enabled: false, connectors: 'all' }), 'utf8');
    const r = await runCli(
      ['agents', 'config', 'reviewer', '--file', file, '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: `/v1/projects/${PROJECT}/agents/reviewer/config`,
        body: { enabled: false, connectors: 'all' },
      },
    ]);
  });

  test('a malformed --set exits 2 before any request', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['agents', 'config', 'reviewer', '--set', 'nonsense', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--set needs <key>=<value>');
  });
});
