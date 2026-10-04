import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// KRTX-1486 — `kortix cr` must resolve ONE principal.
//
// Inside an agent sandbox the CLI holds two disjoint principals:
//   - the ambient session pair (KORTIX_TOKEN + KORTIX_PROJECT_ID), bound to
//     the sandbox's own project, and
//   - the CLI config principal (a logged-in host + its default project or a
//     .kortix/link.json binding).
// `resolveProjectContext` resolved them independently, so `kortix cr ls/open`
// without `--host` authenticated with the ambient session token while the
// project came from the config side. Writes failed 403 cross-project; reads
// silently returned the token-bound project's change requests.
//
// The contract under test: the change-request commands prefer the configured
// principal, and the project always travels with ITS OWN host's credential —
// never with the ambient session token.

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };

const SANDBOX_PROJECT = '11111111-1111-4111-8111-111111111111';
const LINKED_PROJECT = '22222222-2222-4222-8222-222222222222';
const SANDBOX_TOKEN = 'kortix_pat_sandbox_session';
const CONFIG_TOKEN = 'kortix_pat_config_host';

interface Call {
  method: string;
  path: string;
  token: string | null;
}

interface Server {
  base: string;
  calls: Call[];
  stop(): void;
}

function changeRequest(projectId: string, number_: number) {
  return {
    cr_id: `aaaaaaaa-0000-4000-8000-00000000000${number_}`,
    account_id: 'account_1',
    project_id: projectId,
    number: number_,
    title: `CR ${number_}`,
    description: '',
    base_ref: 'main',
    head_ref: 'agent/branch',
    status: 'open',
    head_commit_sha: 'aaaaaaa1111',
    base_commit_sha: 'bbbbbbb2222',
    origin_session_id: null,
    created_by: 'user_1',
    merged_at: null,
    merged_by: null,
    merge_commit_sha: null,
    closed_at: null,
    closed_by: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** A fake Kortix host that enforces the real project-scope rule: a
 *  project-scoped PAT may only touch its own project — anything else answers
 *  403 cross-project, exactly like apps/api's token-project-scope gate. */
function startHost(opts: { token: string; ownProject: string; number_: number }): Server {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      calls.push({
        method: req.method,
        path: url.pathname,
        token: req.headers.get('authorization')?.replace(/^Bearer\s+/, '') ?? null,
      });
      if (req.headers.get('authorization') !== `Bearer ${opts.token}`) {
        return Response.json({ error: 'Invalid PAT' }, { status: 401 });
      }
      if (!url.pathname.startsWith(`/v1/projects/${opts.ownProject}/`)) {
        return Response.json(
          {
            error: true,
            message: `Project-scoped token cannot access a different project [check=token-project-scope:cross-project principal=session-scoped-pat project=${opts.ownProject} path=${url.pathname}]`,
            status: 403,
          },
          { status: 403 },
        );
      }
      if (url.pathname === `/v1/projects/${opts.ownProject}/change-requests`) {
        if (req.method === 'GET') {
          return Response.json({
            change_requests: [changeRequest(opts.ownProject, opts.number_)],
          });
        }
        return Response.json(changeRequest(opts.ownProject, opts.number_), { status: 201 });
      }
      if (url.pathname.endsWith('/diff')) {
        return Response.json({
          files: [],
          files_changed: 1,
          additions: 1,
          deletions: 0,
          patch: 'diff',
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => server.stop(true),
  };
}

let tmp: string;
let sandboxHost: Server;
let configHost: Server;

function writeLink(host: string, projectId: string): void {
  mkdirSync(join(tmp, '.kortix'), { recursive: true });
  writeFileSync(
    join(tmp, '.kortix', 'link.json'),
    JSON.stringify({
      project_id: projectId,
      account_id: 'account_1',
      host,
      host_url: configHost.base,
      linked_at: '2026-01-01T00:00:00.000Z',
    }),
  );
}

function writeConfig(hosts: Record<string, unknown>): void {
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({ active: 'team', hosts }));
}

/** Sandbox env for one CLI run. `projectId` mirrors whether the platform
 *  injected KORTIX_PROJECT_ID into this sandbox. */
async function runCli(
  args: string[],
  opts: { projectId?: string; hostFlag?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
    KORTIX_TOKEN: SANDBOX_TOKEN,
    KORTIX_API_URL: `${sandboxHost.base}/v1`,
  };
  if (opts.projectId) env.KORTIX_PROJECT_ID = opts.projectId;
  else delete env.KORTIX_PROJECT_ID;
  for (const key of ['KORTIX_BRANCH_NAME', 'KORTIX_HEAD_REF', 'KORTIX_SESSION_ID', 'BASH_ENV']) {
    delete env[key];
  }
  const argv = opts.hostFlag ? [...args, '--host', 'team'] : args;
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...argv],
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-cr-principal-'));
  sandboxHost = startHost({ token: SANDBOX_TOKEN, ownProject: SANDBOX_PROJECT, number_: 7 });
  configHost = startHost({ token: CONFIG_TOKEN, ownProject: LINKED_PROJECT, number_: 3 });
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  sandboxHost.stop();
  configHost.stop();
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe('kortix cr resolves one principal (KRTX-1486)', () => {
  it('cr ls without --host reads the linked project with the linked host credential', async () => {
    // The dogfood repro: a sandbox whose ambient session token belongs to a
    // different project, a cwd linked to the customer's project, and that
    // link's host logged in in the CLI config. No KORTIX_PROJECT_ID — the
    // state in which the write 403'd cross-project.
    writeConfig({
      team: {
        url: `${configHost.base}/v1`,
        token: CONFIG_TOKEN,
        user_id: 'user_1',
        user_email: 'user@example.test',
        account_id: 'account_1',
        logged_in_at: '2026-01-01T00:00:00.000Z',
      },
    });
    writeLink('team', LINKED_PROJECT);

    const { code, stdout } = await runCli(['cr', 'ls', '--json']);

    expect(code).toBe(0);
    expect(stdout).toContain(`"project_id": "${LINKED_PROJECT}"`);
    expect(configHost.calls).toEqual([
      {
        method: 'GET',
        path: `/v1/projects/${LINKED_PROJECT}/change-requests`,
        token: CONFIG_TOKEN,
      },
    ]);
    // The ambient session token never reaches the API for the linked project.
    expect(sandboxHost.calls).toEqual([]);
  });

  it('cr ls prefers the linked project over KORTIX_PROJECT_ID', async () => {
    // The silent-read repro: with the platform-injected KORTIX_PROJECT_ID
    // present, `cr ls` used to list the token-bound project's change
    // requests instead of the linked project's.
    writeConfig({
      team: {
        url: `${configHost.base}/v1`,
        token: CONFIG_TOKEN,
        user_id: 'user_1',
        user_email: 'user@example.test',
        account_id: 'account_1',
        logged_in_at: '2026-01-01T00:00:00.000Z',
      },
    });
    writeLink('team', LINKED_PROJECT);

    const { code, stdout } = await runCli(['cr', 'ls', '--json'], {
      projectId: SANDBOX_PROJECT,
    });

    expect(code).toBe(0);
    expect(stdout).toContain(`"project_id": "${LINKED_PROJECT}"`);
    expect(configHost.calls).toHaveLength(1);
    expect(sandboxHost.calls).toEqual([]);
  });

  it('cr open without --host writes the linked project with the linked host credential', async () => {
    writeConfig({
      team: {
        url: `${configHost.base}/v1`,
        token: CONFIG_TOKEN,
        user_id: 'user_1',
        user_email: 'user@example.test',
        account_id: 'account_1',
        logged_in_at: '2026-01-01T00:00:00.000Z',
      },
    });
    writeLink('team', LINKED_PROJECT);

    const { code, stdout } = await runCli([
      'cr',
      'open',
      '--head',
      'agent/branch',
      '--title',
      'Add the flag',
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain('CR #3');
    expect(configHost.calls).toEqual([
      {
        method: 'POST',
        path: `/v1/projects/${LINKED_PROJECT}/change-requests`,
        token: CONFIG_TOKEN,
      },
      {
        method: 'GET',
        path: `/v1/projects/${LINKED_PROJECT}/change-requests/aaaaaaaa-0000-4000-8000-000000000003/diff`,
        token: CONFIG_TOKEN,
      },
    ]);
    expect(sandboxHost.calls).toEqual([]);
  });

  it('cr ls fails loudly when the linked host has no stored credentials', async () => {
    // The configured host is not logged in here: the CLI must refuse with an
    // explicit pointer to --host instead of sending the ambient session token
    // to a project it cannot touch.
    writeConfig({});
    writeLink('team', LINKED_PROJECT);

    const { code, stderr } = await runCli(['cr', 'ls']);

    expect(code).not.toBe(0);
    expect(stderr).toContain('team');
    expect(stderr).toContain('--host team');
    // No doomed request: the ambient token must never reach either host.
    expect(sandboxHost.calls).toEqual([]);
    expect(configHost.calls).toEqual([]);
  });

  it('cr ls keeps the ambient pair when the link names the sandbox project', async () => {
    // An in-sandbox `kortix ship` links the workspace to the session's own
    // project: the ambient session token is a valid credential for it.
    writeConfig({});
    writeLink('team', SANDBOX_PROJECT);

    const { code, stdout } = await runCli(['cr', 'ls', '--json'], {
      projectId: SANDBOX_PROJECT,
    });

    expect(code).toBe(0);
    expect(stdout).toContain(`"project_id": "${SANDBOX_PROJECT}"`);
    expect(sandboxHost.calls).toHaveLength(1);
    expect(configHost.calls).toEqual([]);
  });

  it('cr ls keeps the zero-config sandbox pair when nothing is configured', async () => {
    writeConfig({});

    const { code, stdout } = await runCli(['cr', 'ls', '--json'], {
      projectId: SANDBOX_PROJECT,
    });

    expect(code).toBe(0);
    expect(stdout).toContain(`"project_id": "${SANDBOX_PROJECT}"`);
    expect(sandboxHost.calls).toHaveLength(1);
    expect(configHost.calls).toEqual([]);
  });

  it('cr ls --host team still resolves the linked project on the named host', async () => {
    writeConfig({
      team: {
        url: `${configHost.base}/v1`,
        token: CONFIG_TOKEN,
        user_id: 'user_1',
        user_email: 'user@example.test',
        account_id: 'account_1',
        logged_in_at: '2026-01-01T00:00:00.000Z',
      },
    });
    writeLink('team', LINKED_PROJECT);

    const { code, stdout } = await runCli(['cr', 'ls', '--json'], { hostFlag: true });

    expect(code).toBe(0);
    expect(stdout).toContain(`"project_id": "${LINKED_PROJECT}"`);
    expect(configHost.calls).toHaveLength(1);
    expect(sandboxHost.calls).toEqual([]);
  });
});
