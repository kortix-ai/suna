import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const SANDBOX_ENV_OVERRIDES = [
  'KORTIX_API_URL',
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_TOKEN',
  'BASH_ENV',
] as const;

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: Array<{ method: string; path: string; authorization: string | null; body?: unknown }> = [];

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_blackbox',
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

async function runCli(args: string[], cwd = tmp, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    ...extraEnv,
  };
  for (const key of SANDBOX_ENV_OVERRIDES) delete env[key];
  Object.assign(env, extraEnv);
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd,
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
  return {
    code,
    stdout,
    stderr,
  };
}

function startMarketplaceServer() {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        authorization: req.headers.get('authorization'),
      });
      if (url.pathname === '/v1/marketplace/items') {
        return Response.json({
          items: [{
            id: 'kortix-starter:pdf',
            registry: 'kortix-starter',
            name: 'pdf',
            type: 'registry:skill',
            title: 'PDF',
            description: 'Read and write PDFs.',
            categories: ['general-knowledge-worker'],
            capabilities: { secrets: [], connectors: [], tools: [], network: [] },
            dependencies: [],
            fileCount: 1,
            external: false,
            marketplaceId: 'kortix',
            marketplaceLabel: 'Kortix',
          }],
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function projectSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    project_id: 'proj_e2e',
    account_id: 'account_1',
    name: 'E2E Project',
    repo_url: 'https://github.com/kortix/e2e-project',
    git_origin_url: 'https://git.kortix.test/proj_e2e',
    default_branch: 'main',
    manifest_path: 'kortix.toml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    dashboard_url: 'https://kortix.test/projects/proj_e2e',
    ...overrides,
  };
}

function catalogItem(name: string) {
  return {
    id: `kortix-starter:${name}`,
    registry: 'kortix-starter',
    name,
    type: 'registry:skill',
    title: name === 'agent-browser' ? 'Agent Browser' : name,
    description: `${name} marketplace item`,
    categories: ['kortix-runtime'],
    capabilities: { secrets: [], connectors: [], tools: [name], network: [] },
    dependencies: [],
    fileCount: 1,
    external: false,
    marketplaceId: 'kortix',
    marketplaceLabel: 'Kortix',
  };
}

function startCliE2eServer() {
  const installed = new Map<string, { name: string; type: string; source: string; installed_at: string | null; file_count: number }>();
  let updateAvailable = true;
  let removed = false;
  let archived = false;

  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const entry: { method: string; path: string; authorization: string | null; body?: unknown } = {
        method: req.method,
        path: `${url.pathname}${url.search}`,
        authorization: req.headers.get('authorization'),
      };
      if (!['GET', 'HEAD'].includes(req.method)) {
        const text = await req.text();
        if (text) {
          try {
            entry.body = JSON.parse(text);
          } catch {
            entry.body = text;
          }
        }
      }
      requests.push(entry);

      if (url.pathname === '/v1/projects' && req.method === 'GET') {
        return Response.json(archived ? [] : [projectSummary()]);
      }
      if (url.pathname === '/v1/projects/proj_e2e' && req.method === 'GET') {
        if (archived) return Response.json({ error: 'Not found' }, { status: 404 });
        return Response.json(projectSummary());
      }
      if (url.pathname === '/v1/projects/missing' && req.method === 'GET') {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (url.pathname === '/v1/projects/proj_e2e' && req.method === 'DELETE') {
        archived = true;
        return Response.json({ ok: true, archived: true, repo_deleted: url.searchParams.get('purge') === 'true' });
      }

      if (url.pathname === '/v1/marketplace/items' && req.method === 'GET') {
        const query = url.searchParams.get('query') ?? '';
        const items = ['agent-browser']
          .filter((name) => !query || name.includes(query) || query === `kortix-starter:${name}`)
          .map(catalogItem);
        return Response.json({ items });
      }
      const itemDetail = url.pathname.match(/^\/v1\/marketplace\/items\/(.+)$/);
      if (itemDetail && req.method === 'GET') {
        const raw = decodeURIComponent(itemDetail[1]!);
        const name = raw.includes(':') ? raw.split(':').pop()! : raw;
        if (name !== 'agent-browser') {
          return Response.json({ error: 'Not found' }, { status: 404 });
        }
        return Response.json(catalogItem(name));
      }

      if (url.pathname === '/v1/projects/proj_e2e/marketplace/install' && req.method === 'POST') {
        const body = entry.body as { id?: string } | undefined;
        if (!body?.id) return Response.json({ error: 'id is required' }, { status: 400 });
        const name = body.id.split(':').pop()!;
        installed.set(name, {
          name,
          type: 'registry:skill',
          source: body.id,
          installed_at: '2026-06-26T00:00:00.000Z',
          file_count: 1,
        });
        removed = false;
        updateAvailable = true;
        return Response.json({
          ok: true,
          commit_sha: `commit_install_${name}`,
          branch: 'main',
          file_count: installed.get(name)!.file_count + 1,
          installed: [{ name, type: installed.get(name)!.type }],
          capabilities: catalogItem(name).capabilities,
        }, { status: 201 });
      }
      if (url.pathname === '/v1/projects/proj_e2e/marketplace' && req.method === 'GET') {
        return Response.json({ installed: [...installed.values()] });
      }
      if (url.pathname === '/v1/projects/proj_e2e/marketplace/updates' && req.method === 'GET') {
        const updates = [...installed.values()].map((item) => ({
          name: item.name,
          type: item.type,
          status: updateAvailable ? 'update-available' : 'up-to-date',
          changed: updateAvailable ? 2 : 0,
        }));
        return Response.json({
          updates,
          update_available: updates.filter((item) => item.status === 'update-available').map((item) => item.name),
        });
      }
      if (url.pathname === '/v1/projects/proj_e2e/marketplace/update' && req.method === 'POST') {
        const body = entry.body as { name?: string } | undefined;
        if (!body?.name || !installed.has(body.name)) return Response.json({ error: 'not installed' }, { status: 404 });
        updateAvailable = false;
        return Response.json({
          ok: true,
          updated: body.name,
          commit_sha: `commit_update_${body.name}`,
          branch: 'main',
          file_count: installed.get(body.name)!.file_count + 1,
        });
      }
      const remove = url.pathname.match(/^\/v1\/projects\/proj_e2e\/marketplace\/(.+)$/);
      if (remove && req.method === 'DELETE') {
        const name = decodeURIComponent(remove[1]!);
        if (!installed.has(name)) return Response.json({ error: `"${name}" is not installed` }, { status: 404 });
        const fileCount = installed.get(name)!.file_count;
        installed.delete(name);
        removed = true;
        return Response.json({
          ok: true,
          removed: name,
          commit_sha: `commit_remove_${name}`,
          branch: 'main',
          file_count: fileCount,
        });
      }

      return Response.json({ error: 'not found', removed }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

describe('kortix CLI black-box behavior', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-cli-blackbox-'));
    requests = [];
    process.env = { ...ORIGINAL_ENV };
    for (const key of SANDBOX_ENV_OVERRIDES) delete process.env[key];
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('marketplace search runs as a process and returns API catalog JSON', async () => {
    const apiBase = startMarketplaceServer();
    const configFile = writeConfig(apiBase);

    const result = await runCli(
      ['marketplace', 'search', 'pdf', '--source', 'kortix', '--json'],
      tmp,
      { KORTIX_CONFIG_FILE: configFile },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).items[0]).toMatchObject({
      id: 'kortix-starter:pdf',
      name: 'pdf',
      marketplaceLabel: 'Kortix',
    });
    expect(result.stderr).toContain('host test');
    expect(requests).toEqual([{
      method: 'GET',
      path: '/v1/marketplace/items?query=pdf&source=kortix',
      authorization: 'Bearer tok_blackbox',
    }]);
  }, 15_000);

  test('marketplace install dry-run resolves through the API before reporting output', async () => {
    const apiBase = startMarketplaceServer();
    const configFile = writeConfig(apiBase);

    const result = await runCli(
      ['marketplace', 'install', 'pdf', '--project', 'proj_1', '--dry-run'],
      tmp,
      { KORTIX_CONFIG_FILE: configFile },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PDF');
    expect(result.stdout).toContain('Dry run');
    expect(result.stdout).toContain('proj_1');
    expect(requests).toEqual([{
      method: 'GET',
      path: '/v1/marketplace/items?query=pdf',
      authorization: 'Bearer tok_blackbox',
    }]);
  }, 15_000);

  test('top-level help exposes marketplace but hides add and registry commands', async () => {
    const result = await runCli(['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('marketplace');
    expect(result.stdout).not.toContain('add <item>');
    expect(result.stdout).not.toContain('registry <subcommand>');
  });

  test('add is not a top-level command', async () => {
    const apiBase = startMarketplaceServer();
    const configFile = writeConfig(apiBase);

    const result = await runCli(
      ['add', 'pdf', '--project', 'proj_1', '--dry-run'],
      tmp,
      { KORTIX_CONFIG_FILE: configFile },
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('`add` is not a kortix subcommand');
    expect(requests).toEqual([]);
  }, 15_000);

  test('init --yes writes the minimal starter by default', async () => {
    const result = await runCli(['init', 'minimal-project', '--yes', '--no-git']);

    expect(result.code).toBe(0);
    const root = join(tmp, 'minimal-project');
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'kortix-system', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'kortix-computer', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'agent-browser', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(root, '.kortix', 'opencode', 'plugins', 'pty.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'memory.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'web_search.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'scrape_webpage.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'image_search.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'pdf', 'SKILL.md'))).toBe(false);
  });

  test('init can explicitly opt into the general knowledge worker skill pack', async () => {
    const result = await runCli([
      'init',
      'gkw-project',
      '--yes',
      '--no-git',
      '--template',
      'general-knowledge-worker',
    ]);

    expect(result.code).toBe(0);
    const root = join(tmp, 'gkw-project');
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'kortix-system', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'pdf', 'SKILL.md'))).toBe(true);
  });

  test('init can install selected bundled marketplace skills locally', async () => {
    const result = await runCli([
      'init',
      'marketplace-project',
      '--yes',
      '--no-git',
      '--marketplace',
      'agent-browser',
    ]);

    expect(result.code).toBe(0);
    const root = join(tmp, 'marketplace-project');
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'show.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'plugins', 'pty.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'plugins', 'opencode-pty', 'src', 'plugin', 'constants.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'web_search.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'lib', 'get-env.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'agent-browser', 'SKILL.md'))).toBe(true);

    const lock = JSON.parse(readFileSync(join(root, 'registry-lock.json'), 'utf8'));
    expect(lock.version).toBe(2);
    expect(Object.keys(lock.items).sort()).toEqual(['agent-browser']);
  });

  test('E2E: CLI project setup plus marketplace install/status/update/remove lifecycle', async () => {
    const apiBase = startCliE2eServer();
    const configFile = writeConfig(apiBase);

    const init = await runCli(['init', 'full-e2e', '--yes', '--no-git']);
    expect(init.code).toBe(0);
    const root = join(tmp, 'full-e2e');
    expect(existsSync(join(root, 'kortix.yaml'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'show.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'kortix-system', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'skills', 'agent-browser', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(root, '.kortix', 'opencode', 'plugins', 'pty.ts'))).toBe(true);
    expect(existsSync(join(root, '.kortix', 'opencode', 'tools', 'web_search.ts'))).toBe(true);

    const listBeforeLink = await runCli(['projects', 'ls', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(listBeforeLink.code).toBe(0);
    expect(JSON.parse(listBeforeLink.stdout)).toEqual([expect.objectContaining({ project_id: 'proj_e2e', name: 'E2E Project' })]);

    const link = await runCli(['projects', 'link', 'proj_e2e'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(link.code).toBe(0);
    expect(link.stdout).toContain('Linked');
    const linked = JSON.parse(readFileSync(join(root, '.kortix', 'link.json'), 'utf8'));
    expect(linked).toMatchObject({ project_id: 'proj_e2e', account_id: 'account_1', host: 'test', host_url: apiBase });

    const info = await runCli(['projects', 'info', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout)).toMatchObject({ project_id: 'proj_e2e', default_branch: 'main' });

    const search = await runCli(['marketplace', 'search', 'agent-browser', '--source', 'kortix', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout).items).toEqual([
      expect.objectContaining({
        id: 'kortix-starter:agent-browser',
        name: 'agent-browser',
        type: 'registry:skill',
        capabilities: expect.objectContaining({ tools: ['agent-browser'] }),
      }),
    ]);

    const show = await runCli(['marketplace', 'show', 'agent-browser', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(show.code).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({ id: 'kortix-starter:agent-browser', name: 'agent-browser', type: 'registry:skill' });

    const dryInstall = await runCli(['marketplace', 'install', 'agent-browser', '--dry-run'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(dryInstall.code).toBe(0);
    expect(dryInstall.stdout).toContain('Dry run');
    expect(dryInstall.stdout).toContain('proj_e2e');

    const install = await runCli(['marketplace', 'install', 'agent-browser', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(install.code).toBe(0);
    expect(JSON.parse(install.stdout)).toMatchObject({
      ok: true,
      commit_sha: 'commit_install_agent-browser',
      branch: 'main',
      installed: [{ name: 'agent-browser', type: 'registry:skill' }],
    });

    const status = await runCli(['marketplace', 'status', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).installed).toEqual([
      expect.objectContaining({ name: 'agent-browser', type: 'registry:skill', source: 'kortix-starter:agent-browser', file_count: 1 }),
    ]);

    const updates = await runCli(['marketplace', 'updates', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(updates.code).toBe(0);
    expect(JSON.parse(updates.stdout)).toMatchObject({ update_available: ['agent-browser'] });

    const update = await runCli(['marketplace', 'update', 'agent-browser', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(update.code).toBe(0);
    expect(JSON.parse(update.stdout)).toMatchObject({ ok: true, updated: 'agent-browser', commit_sha: 'commit_update_agent-browser' });

    const updatesAfter = await runCli(['marketplace', 'updates', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(updatesAfter.code).toBe(0);
    expect(JSON.parse(updatesAfter.stdout)).toMatchObject({ update_available: [] });

    const remove = await runCli(['marketplace', 'remove', 'agent-browser', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(remove.code).toBe(0);
    expect(JSON.parse(remove.stdout)).toMatchObject({ ok: true, removed: 'agent-browser', commit_sha: 'commit_remove_agent-browser' });

    const statusAfterRemove = await runCli(['marketplace', 'status', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(statusAfterRemove.code).toBe(0);
    expect(JSON.parse(statusAfterRemove.stdout).installed).toEqual([]);

    const unlink = await runCli(['projects', 'unlink'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(unlink.code).toBe(0);
    expect(existsSync(join(root, '.kortix', 'link.json'))).toBe(false);

    const relink = await runCli(['projects', 'link', 'proj_e2e'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(relink.code).toBe(0);
    expect(existsSync(join(root, '.kortix', 'link.json'))).toBe(true);

    const removeProject = await runCli(['projects', 'rm', 'proj_e2e', '--purge', '--yes'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(removeProject.code).toBe(0);
    expect(removeProject.stdout).toContain('Archived');
    expect(existsSync(join(root, '.kortix', 'link.json'))).toBe(false);

    expect(requests.map((r) => [r.method, r.path, r.body ?? null])).toEqual([
      // `projects ls` is scoped to the active account; by-id routes are not.
      ['GET', '/v1/projects?account_id=account_1', null],
      ['GET', '/v1/projects/proj_e2e', null],
      ['GET', '/v1/projects/proj_e2e', null],
      ['GET', '/v1/marketplace/items?query=agent-browser&source=kortix', null],
      ['GET', '/v1/marketplace/items/agent-browser', null],
      ['GET', '/v1/marketplace/items?query=agent-browser', null],
      ['GET', '/v1/marketplace/items?query=agent-browser', null],
      ['POST', '/v1/projects/proj_e2e/marketplace/install', { id: 'kortix-starter:agent-browser' }],
      ['GET', '/v1/projects/proj_e2e/marketplace', null],
      ['GET', '/v1/projects/proj_e2e/marketplace/updates', null],
      ['POST', '/v1/projects/proj_e2e/marketplace/update', { name: 'agent-browser' }],
      ['GET', '/v1/projects/proj_e2e/marketplace/updates', null],
      ['DELETE', '/v1/projects/proj_e2e/marketplace/agent-browser', null],
      ['GET', '/v1/projects/proj_e2e/marketplace', null],
      ['GET', '/v1/projects/proj_e2e', null],
      ['GET', '/v1/projects/proj_e2e', null],
      ['DELETE', '/v1/projects/proj_e2e?purge=true', null],
    ]);
    expect(requests.every((r) => r.authorization === 'Bearer tok_blackbox')).toBe(true);
  }, 30_000);

  test('E2E edge cases: auth, link, not-found, removed add command, and missing installs', async () => {
    const apiBase = startCliE2eServer();
    const configFile = writeConfig(apiBase);

    const noAuth = await runCli(['marketplace', 'search', 'pty', '--json'], tmp, { KORTIX_CONFIG_FILE: join(tmp, 'missing-config.json') });
    expect(noAuth.code).toBe(1);
    expect(noAuth.stderr).toContain('Not logged in');

    const noLink = await runCli(['marketplace', 'status', '--json'], tmp, { KORTIX_CONFIG_FILE: configFile });
    expect(noLink.code).toBe(1);
    expect(noLink.stderr).toContain('No project linked');

    const init = await runCli(['init', 'edge-e2e', '--yes', '--no-git']);
    expect(init.code).toBe(0);
    const root = join(tmp, 'edge-e2e');

    const missingProject = await runCli(['projects', 'link', 'missing'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(missingProject.code).toBe(1);
    expect(missingProject.stderr).toContain('Not found');

    const unknownShow = await runCli(['marketplace', 'show', 'does-not-exist'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(unknownShow.code).toBe(1);
    expect(unknownShow.stderr).toContain('No marketplace item matches');

    const unknownInstall = await runCli(['marketplace', 'install', 'does-not-exist', '--project', 'proj_e2e'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(unknownInstall.code).toBe(1);
    expect(unknownInstall.stderr).toContain('No marketplace item matches');

    const removeMissing = await runCli(['marketplace', 'remove', 'pty', '--project', 'proj_e2e', '--json'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(removeMissing.code).toBe(1);
    expect(removeMissing.stderr).toContain('not installed');

    const add = await runCli(['add', 'pty', '--project', 'proj_e2e'], root, { KORTIX_CONFIG_FILE: configFile });
    expect(add.code).toBe(2);
    expect(add.stderr).toContain('`add` is not a kortix subcommand');

    expect(requests.map((r) => [r.method, r.path, r.body ?? null])).toEqual([
      ['GET', '/v1/projects/missing', null],
      ['GET', '/v1/marketplace/items/does-not-exist', null],
      ['GET', '/v1/marketplace/items?query=does-not-exist', null],
      ['GET', '/v1/marketplace/items?query=does-not-exist', null],
      ['DELETE', '/v1/projects/proj_e2e/marketplace/pty', null],
    ]);
  }, 30_000);
});
