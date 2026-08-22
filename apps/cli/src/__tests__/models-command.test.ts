import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const MODELS_MODULE = join(CLI_ROOT, 'src', 'commands', 'models.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_models';

/**
 * `kortix models` is dispatched from src/index.ts. Until that wiring lands the
 * root entry answers "unknown command", which would make every assertion below
 * about a routing gap instead of about the command. So the tests spawn a
 * generated entry that calls `runModels` as a REAL process — same argv parsing,
 * same exit code, same HTTP, same stdout/stderr split — and switch to the root
 * entry automatically the moment `models` is a known command there.
 */
async function resolveEntry(): Promise<{ cmd: string[]; usesRootEntry: boolean }> {
  const probe = Bun.spawnSync({
    cmd: [process.execPath, CLI_ENTRY, 'models', '--help'],
    env: { ...process.env, KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
  });
  if (probe.exitCode === 0) return { cmd: [CLI_ENTRY, 'models'], usesRootEntry: true };
  const shim = join(tmp, 'models-entry.ts');
  writeFileSync(
    shim,
    `import { runModels } from ${JSON.stringify(MODELS_MODULE)};\n` +
      'process.exit(await runModels(process.argv.slice(2)));\n',
    'utf8',
  );
  return { cmd: [shim], usesRootEntry: false };
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_models',
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

/** Mirrors GET /projects/:id/model-picker (apps/api/src/projects/routes/r4.ts:3046). */
function picker(overrides: Record<string, boolean>) {
  const models: Record<string, unknown> = {
    'glm-5.2': { name: 'GLM 5.2', provider: 'zai' },
    'anthropic/claude-opus-4-8': { name: 'Claude Opus 4.8', provider: 'anthropic' },
    'openai/gpt-5.5': { name: 'GPT-5.5', provider: 'openai' },
  };
  const defaultEnabled = new Set(['glm-5.2', 'anthropic/claude-opus-4-8']);
  return {
    models: Object.fromEntries(
      Object.entries(models).map(([id, m]) => [
        id,
        { ...(m as object), enabled: overrides[id] ?? defaultEnabled.has(id) },
      ]),
    ),
    modelOverrides: overrides,
    defaultModel: 'glm-5.2',
    usingDefaults: Object.keys(overrides).length === 0,
  };
}

function startServer(seed: Record<string, boolean> = {}): string {
  let overrides = { ...seed };
  let projectDefault: string | null = 'glm-5.2';
  let accountDefault: string | null = null;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json();
      calls.push({ method: req.method, path: url.pathname, query: url.search, body });
      const p = url.pathname;
      if (p === `/v1/projects/${PROJECT}/model-picker` && req.method === 'GET') {
        return Response.json(picker(overrides));
      }
      if (p === `/v1/projects/${PROJECT}/model-enablement` && req.method === 'PUT') {
        const next = (body as { modelOverrides: Record<string, boolean> }).modelOverrides;
        if (next['glm-5.2'] === false) {
          return Response.json(
            {
              error: 'Cannot disable the project default model — change the default first.',
              code: 'cannot_disable_default',
            },
            { status: 409 },
          );
        }
        overrides = next;
        return Response.json({ ok: true, modelOverrides: next });
      }
      if (p === `/v1/projects/${PROJECT}/model-defaults`) {
        if (req.method === 'GET') {
          return Response.json({
            platformDefault: 'openai/gpt-5.5',
            accountDefault,
            agentDefaults: { reviewer: 'anthropic/claude-opus-4-8' },
            projectDefault,
            resolvedForCaller: projectDefault ?? accountDefault ?? 'openai/gpt-5.5',
            resolvedSource: projectDefault ? 'project' : 'platform',
            freeTier: false,
          });
        }
        if (req.method === 'PUT') {
          const b = body as { scope: string; model: string };
          if (b.scope === 'project') projectDefault = b.model;
          if (b.scope === 'account') accountDefault = b.model;
          return Response.json({ ok: true, scope: b.scope, model: b.model });
        }
        if (req.method === 'DELETE') {
          const scope = url.searchParams.get('scope');
          if (scope === 'project') projectDefault = null;
          if (scope === 'account') accountDefault = null;
          return Response.json({ ok: true, scope });
        }
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

/** `args` always starts with 'models' so the calls read like the real CLI. */
async function runCli(args: string[], configFile?: string) {
  const entry = await resolveEntry();
  const rest = args[0] === 'models' ? args.slice(1) : args;
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
    cmd: [process.execPath, ...entry.cmd, ...rest],
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

describe('kortix models', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-models-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents every subcommand and the permission it needs', async () => {
    const r = await runCli(['models', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: kortix models');
    expect(r.stdout).toContain('enable <model-id>');
    expect(r.stdout).toContain('disable <model-id>');
    expect(r.stdout).toContain('reset');
    expect(r.stdout).toContain('default <model-id>');
    expect(r.stdout).toContain('project.customize.write');
  });

  test('no args exits 2 with help', async () => {
    const r = await runCli(['models']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('Usage: kortix models');
  });

  test('ls prints state/origin per model and marks the default; --json is the raw payload', async () => {
    const config = writeConfig(startServer({ 'openai/gpt-5.5': true }));
    const r = await runCli(['models', 'ls', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/anthropic\/claude-opus-4-8\s+on\s+default/);
    expect(r.stdout).toMatch(/openai\/gpt-5\.5\s+on\s+override/);
    // The default carries the ● marker and is named in the footer.
    expect(r.stdout).toContain('● glm-5.2');
    expect(r.stdout).toContain('project default (glm-5.2)');

    const j = await runCli(['models', 'ls', '--project', PROJECT, '--json'], config);
    expect(j.code).toBe(0);
    const payload = JSON.parse(j.stdout) as { defaultModel: string; modelOverrides: unknown };
    expect(payload.defaultModel).toBe('glm-5.2');
    expect(payload.modelOverrides).toEqual({ 'openai/gpt-5.5': true });
  });

  test('enable MERGES into the stored overrides before the replace-whole-map PUT', async () => {
    const config = writeConfig(startServer({ 'openai/gpt-5.5': false }));
    const r = await runCli(
      ['models', 'enable', 'openai/gpt-5.5', 'anthropic/claude-opus-4-8', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe(`/v1/projects/${PROJECT}/model-enablement`);
    expect(put?.body).toEqual({
      modelOverrides: { 'openai/gpt-5.5': true, 'anthropic/claude-opus-4-8': true },
    });
    expect(r.stdout).toContain('2 models offered');
    // It read the current map first — that is what makes the merge honest.
    expect(calls[0]).toMatchObject({ method: 'GET', path: `/v1/projects/${PROJECT}/model-picker` });
  });

  test('disable sends false for that id only, and surfaces the 409 on the project default', async () => {
    const config = writeConfig(startServer({}));
    const ok = await runCli(
      ['models', 'disable', 'anthropic/claude-opus-4-8', '--project', PROJECT],
      config,
    );
    expect(ok.code).toBe(0);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      modelOverrides: { 'anthropic/claude-opus-4-8': false },
    });

    calls = [];
    const conflict = await runCli(['models', 'disable', 'glm-5.2', '--project', PROJECT], config);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('Cannot disable the project default model');
  });

  test('reset PUTs an empty map', async () => {
    const config = writeConfig(startServer({ 'openai/gpt-5.5': true }));
    const r = await runCli(['models', 'reset', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: `/v1/projects/${PROJECT}/model-enablement`,
        query: '',
        body: { modelOverrides: {} },
      },
    ]);
    expect(r.stdout).toContain('Every exception dropped');
  });

  test('an id the project does not serve is refused before any write', async () => {
    const config = writeConfig(startServer({}));
    const r = await runCli(['models', 'enable', 'not-a-model', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Not served by this project: not-a-model');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  test('enable with no id exits 2', async () => {
    const config = writeConfig(startServer({}));
    const r = await runCli(['models', 'enable', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass at least one model id to enable.');
  });

  test('default with no arg prints the chain; --json emits the raw defaults', async () => {
    const config = writeConfig(startServer({}));
    const r = await runCli(['models', 'default', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/project\s+glm-5\.2/);
    expect(r.stdout).toMatch(/account\s+unset/);
    expect(r.stdout).toMatch(/platform\s+openai\/gpt-5\.5/);
    expect(r.stdout).toContain('resolves to glm-5.2 (project)');
    expect(r.stdout).toContain('1 per-agent pin');

    const j = await runCli(['models', 'default', '--project', PROJECT, '--json'], config);
    expect(JSON.parse(j.stdout).projectDefault).toBe('glm-5.2');
  });

  test('default <id> PUTs scope=project; --account switches scope', async () => {
    const config = writeConfig(startServer({}));
    const p = await runCli(['models', 'default', 'openai/gpt-5.5', '--project', PROJECT], config);
    expect(p.code).toBe(0);
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: `/v1/projects/${PROJECT}/model-defaults`,
      body: { scope: 'project', model: 'openai/gpt-5.5' },
    });
    expect(p.stdout).toContain('project default → openai/gpt-5.5');

    const a = await runCli(
      ['models', 'default', 'glm-5.2', '--account', '--project', PROJECT],
      config,
    );
    expect(a.code).toBe(0);
    expect(calls.at(-1)).toMatchObject({ body: { scope: 'account', model: 'glm-5.2' } });
  });

  test('default --clear DELETEs with the right scope', async () => {
    const config = writeConfig(startServer({}));
    const r = await runCli(['models', 'default', '--clear', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/v1/projects/${PROJECT}/model-defaults`,
      query: '?scope=project',
    });
    expect(r.stdout).toContain('Cleared the project default model');

    const acct = await runCli(
      ['models', 'default', '--clear', '--account', '--project', PROJECT],
      config,
    );
    expect(acct.code).toBe(0);
    expect(calls.at(-1)).toMatchObject({ query: '?scope=account' });
  });

  test('an unknown subcommand exits 2 with help', async () => {
    const config = writeConfig(startServer({}));
    const r = await runCli(['models', 'nope', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "nope"');
  });
});
