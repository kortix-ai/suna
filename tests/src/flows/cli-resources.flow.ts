/**
 * Real-process coverage for the workspace-scoped CLI resource commands and
 * their deprecated Project compatibility aliases.
 *
 * Each command starts apps/cli/src/index.ts in an isolated process. The flows
 * assert exit status, JSON/stdout, local files, and API read-back state.
 */
import { flow } from '../core/flow';
import { CliSandbox, type CliResult } from '../fixtures/cli';

function requireExit(result: CliResult, expected: number, action: string): void {
  if (result.exitCode !== expected) {
    throw new Error(`${action} exited ${result.exitCode}, expected ${expected}: ${result.all}`);
  }
}

function parseJson<T>(result: CliResult, action: string): T {
  requireExit(result, 0, action);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${action} returned invalid JSON: ${result.stdout}\n${result.stderr}`);
  }
}

async function authenticatedCli(ctx: Parameters<Parameters<typeof flow>[2]>[0], label: string) {
  const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name(`cli-${label}`) });
  const sandbox = new CliSandbox(label);
  const login = await sandbox.login(pat, {
    noProject: true,
    account: ctx.P.OWNER.accountId,
  });
  requireExit(login, 0, 'kortix login');
  return sandbox;
}

flow(
  'CLI-PROJ',
  {
    domain: 'cli',
    routes: [
      'GET /v1/accounts/me',
      'GET /v1/workspaces',
      'GET /v1/workspaces/:workspaceId',
      'GET /v1/projects',
      'GET /v1/projects/:projectId',
      'DELETE /v1/projects/:projectId',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const sandbox = await authenticatedCli(ctx, 'projects');
    try {
      await ctx.step('kortix workspaces ls --json uses the canonical Workspace shape', async () => {
        const result = await sandbox.run(['workspaces', 'ls', '--json']);
        const workspaces = parseJson<Array<{ workspace_id: string }>>(
          result,
          'kortix workspaces ls',
        );
        if (!workspaces.some((item) => item.workspace_id === project.id)) {
          throw new Error(`workspaces ls omitted ${project.id}`);
        }
        if (result.stdout.includes('project_id')) {
          throw new Error(`workspaces ls leaked the legacy Project shape: ${result.stdout}`);
        }
      });

      await ctx.step('kortix workspaces info <id> returns the canonical Workspace URL', async () => {
        const item = parseJson<{ workspace_id: string; dashboard_url?: string }>(
          await sandbox.run(['workspaces', 'info', project.id, '--json']),
          'kortix workspaces info',
        );
        if (item.workspace_id !== project.id) {
          throw new Error(`workspaces info returned ${item.workspace_id}`);
        }
        if (!item.dashboard_url?.includes(`/workspaces/${project.id}`)) {
          throw new Error(`workspaces info returned the wrong URL: ${item.dashboard_url}`);
        }
      });

      await ctx.step('kortix projects ls --json lists the run-owned project', async () => {
        const projects = parseJson<Array<{ project_id: string }>>(
          await sandbox.run(['projects', 'ls', '--json']),
          'kortix projects ls',
        );
        if (!projects.some((item) => item.project_id === project.id)) {
          throw new Error(`projects ls omitted ${project.id}`);
        }
      });

      await ctx.step('kortix projects info <id> returns the exact project', async () => {
        const item = parseJson<{ project_id: string }>(
          await sandbox.run(['projects', 'info', project.id, '--json']),
          'kortix projects info',
        );
        if (item.project_id !== project.id) throw new Error(`projects info returned ${item.project_id}`);
      });

      await ctx.step('canonical and legacy link commands preserve their own wire shapes', async () => {
        requireExit(
          await sandbox.run(['init', 'linked', '-y', '--no-git']),
          0,
          'kortix init',
        );
        sandbox.enter('linked');

        requireExit(await sandbox.run(['workspaces', 'link', project.id]), 0, 'kortix workspaces link');
        const workspaceLink = JSON.parse(sandbox.readFile('.kortix/link.json')) as {
          workspace_id: string;
          project_id?: string;
        };
        if (
          workspaceLink.workspace_id !== project.id ||
          workspaceLink.project_id !== project.id
        ) {
          throw new Error(`workspace link has the wrong shape: ${JSON.stringify(workspaceLink)}`);
        }
        requireExit(await sandbox.run(['workspaces', 'unlink']), 0, 'kortix workspaces unlink');
        if (sandbox.exists('.kortix/link.json')) throw new Error('workspaces unlink left link.json behind');

        requireExit(await sandbox.run(['projects', 'link', project.id]), 0, 'kortix projects link');
        const link = JSON.parse(sandbox.readFile('.kortix/link.json')) as { project_id: string };
        if (link.project_id !== project.id) throw new Error(`link points at ${link.project_id}`);
        requireExit(await sandbox.run(['projects', 'unlink']), 0, 'kortix projects unlink');
        if (sandbox.exists('.kortix/link.json')) throw new Error('projects unlink left link.json behind');
      });

      await ctx.step('kortix workspaces open prints the canonical dashboard URL', async () => {
        const result = await sandbox.run(['workspaces', 'open', project.id]);
        requireExit(result, 0, 'kortix workspaces open');
        if (!result.stdout.includes(`/workspaces/${project.id}`)) {
          throw new Error(`workspaces open printed the wrong URL: ${result.stdout}`);
        }
      });

      await ctx.step('kortix projects open prints the dashboard URL without changing state', async () => {
        const result = await sandbox.run(['projects', 'open', project.id]);
        requireExit(result, 0, 'kortix projects open');
        if (!result.stdout.includes(`/projects/${project.id}`)) {
          throw new Error(`projects open printed the wrong URL: ${result.stdout}`);
        }
      });

      await ctx.step('kortix projects rm archives the project through the real DELETE route', async () => {
        const result = await sandbox.run(['projects', 'rm', project.id, '--yes']);
        requireExit(result, 0, 'kortix projects rm');
        if (!/Archived/.test(result.stdout)) throw new Error(`projects rm output: ${result.stdout}`);
      });
    } finally {
      sandbox.dispose();
    }
  },
);

flow(
  'CLI-SEC',
  {
    domain: 'cli',
    routes: [
      'GET /v1/accounts/me',
      'GET /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/secrets',
      'DELETE /v1/projects/:projectId/secrets/:name',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const sandbox = await authenticatedCli(ctx, 'secrets');
    try {
      await ctx.step('kortix secrets set stores one value and secrets ls returns metadata only', async () => {
        requireExit(
          await sandbox.run(['secrets', 'set', 'CLI_SECRET=private-value', '--project', project.id]),
          0,
          'kortix secrets set',
        );
        const result = parseJson<{ secrets: Array<{ identifier: string; available: boolean }> }>(
          await sandbox.run(['secrets', 'ls', '--project', project.id, '--json']),
          'kortix secrets ls',
        );
        const secret = result.secrets.find((item) => item.identifier === 'CLI_SECRET');
        if (!secret?.available) throw new Error('secrets ls did not report CLI_SECRET as available');
        if (JSON.stringify(result).includes('private-value')) {
          throw new Error('secrets ls leaked the plaintext value');
        }
      });

      await ctx.step('kortix env pull writes a names-only dotenv skeleton', async () => {
        requireExit(
          await sandbox.run([
            'env',
            'pull',
            '--project',
            project.id,
            '--out',
            'pulled.env',
            '--force',
          ]),
          0,
          'kortix env pull',
        );
        const dotenv = sandbox.readFile('pulled.env');
        if (!dotenv.includes('CLI_SECRET=')) throw new Error(`env pull omitted CLI_SECRET: ${dotenv}`);
        if (dotenv.includes('private-value')) throw new Error('env pull leaked the plaintext value');
      });

      await ctx.step('kortix env push uploads every non-empty dotenv pair', async () => {
        sandbox.writeFile('push.env', 'CLI_PUSHED=second-value\n');
        requireExit(
          await sandbox.run(['env', 'push', '--project', project.id, '--from', 'push.env']),
          0,
          'kortix env push',
        );
        const result = parseJson<{ secrets: Array<{ identifier: string }> }>(
          await sandbox.run(['secrets', 'ls', '--project', project.id, '--json']),
          'kortix secrets ls after env push',
        );
        if (!result.secrets.some((item) => item.identifier === 'CLI_PUSHED')) {
          throw new Error('env push did not create CLI_PUSHED');
        }
      });

      await ctx.step('kortix secrets unset removes both values', async () => {
        requireExit(
          await sandbox.run([
            'secrets',
            'unset',
            'CLI_SECRET',
            'CLI_PUSHED',
            '--project',
            project.id,
          ]),
          0,
          'kortix secrets unset',
        );
        const result = parseJson<{ secrets: Array<{ identifier: string }> }>(
          await sandbox.run(['secrets', 'ls', '--project', project.id, '--json']),
          'kortix secrets ls after unset',
        );
        if (result.secrets.some((item) => ['CLI_SECRET', 'CLI_PUSHED'].includes(item.identifier))) {
          throw new Error('secrets unset left a deleted identifier in the list');
        }
      });
    } finally {
      sandbox.dispose();
    }
  },
);

flow(
  'CLI-SESS',
  {
    domain: 'cli',
    serial: true,
    timeoutMs: 300_000,
    requires: ['daytona', 'funded'],
    routes: [
      'GET /v1/accounts/me',
      'GET /v1/projects/:projectId',
      'GET /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/sessions/:sessionId/restart',
      'DELETE /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ seed: true });
    const sandbox = await authenticatedCli(ctx, 'sessions');
    try {
      let sessionId = '';
      await ctx.step('kortix sessions new creates a session and returns its id', async () => {
        const created = parseJson<{ session_id: string }>(
          await sandbox.run(['sessions', 'new', '--project', project.id, '--json'], {
            timeoutMs: 120_000,
          }),
          'kortix sessions new',
        );
        sessionId = created.session_id;
        if (!sessionId) throw new Error('sessions new returned no session_id');
        ctx.track('session', sessionId, { projectId: project.id });
      });

      await ctx.step('kortix sessions ls and info read the same session', async () => {
        const list = parseJson<Array<{ session_id: string }>>(
          await sandbox.run(['sessions', 'ls', '--project', project.id, '--json']),
          'kortix sessions ls',
        );
        if (!list.some((item) => item.session_id === sessionId)) {
          throw new Error(`sessions ls omitted ${sessionId}`);
        }
        const item = parseJson<{ session_id: string }>(
          await sandbox.run(['sessions', 'info', sessionId, '--project', project.id, '--json']),
          'kortix sessions info',
        );
        if (item.session_id !== sessionId) throw new Error(`sessions info returned ${item.session_id}`);
      });

      await ctx.step('kortix sessions open prints the exact dashboard session URL', async () => {
        const result = await sandbox.run(['sessions', 'open', sessionId, '--project', project.id]);
        requireExit(result, 0, 'kortix sessions open');
        if (!result.stdout.includes(`/sessions/${sessionId}`)) {
          throw new Error(`sessions open printed the wrong URL: ${result.stdout}`);
        }
      });

      await ctx.step('kortix sessions restart calls the real restart route', async () => {
        const result = await sandbox.run(['sessions', 'restart', sessionId, '--project', project.id], {
          timeoutMs: 120_000,
        });
        requireExit(result, 0, 'kortix sessions restart');
      });

      await ctx.step('kortix sessions rm deletes the session and the next info fails', async () => {
        requireExit(
          await sandbox.run(['sessions', 'rm', sessionId, '--project', project.id], {
            timeoutMs: 120_000,
          }),
          0,
          'kortix sessions rm',
        );
        const missing = await sandbox.run([
          'sessions',
          'info',
          sessionId,
          '--project',
          project.id,
          '--json',
        ]);
        requireExit(missing, 1, 'kortix sessions info after delete');
      });
    } finally {
      sandbox.dispose();
    }
  },
);

flow(
  'CLI-TRG',
  {
    domain: 'cli',
    serial: true,
    timeoutMs: 180_000,
    requires: ['daytona', 'funded'],
    routes: [
      'GET /v1/accounts/me',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ seed: true });
    const slug = `cli-trigger-${Date.now()}`;
    const created = await ctx.client.as(ctx.P.OWNER).post(
      '/v1/projects/:projectId/triggers',
      {
        name: slug,
        slug,
        type: 'cron',
        cron: '0 0 3 * * *',
        timezone: 'UTC',
        prompt_template: 'Report test status',
      },
      { params: { projectId: project.id } },
    );
    created.status(201);

    const sandbox = await authenticatedCli(ctx, 'triggers');
    try {
      await ctx.step('kortix triggers ls and info return the server trigger', async () => {
        const list = parseJson<{ triggers: Array<{ slug: string }> }>(
          await sandbox.run(['triggers', 'ls', '--project', project.id, '--json']),
          'kortix triggers ls',
        );
        if (!list.triggers.some((item) => item.slug === slug)) {
          throw new Error(`triggers ls omitted ${slug}`);
        }
        const info = parseJson<{ slug: string }>(
          await sandbox.run(['triggers', 'info', slug, '--project', project.id, '--json']),
          'kortix triggers info',
        );
        if (info.slug !== slug) throw new Error(`triggers info returned ${info.slug}`);
      });

      await ctx.step('kortix triggers fire starts or queues the configured trigger', async () => {
        const result = await sandbox.run(['triggers', 'fire', slug, '--project', project.id], {
          timeoutMs: 120_000,
        });
        requireExit(result, 0, 'kortix triggers fire');
        if (!/(Fired|Queued)/.test(result.stdout)) {
          throw new Error(`triggers fire output: ${result.stdout}`);
        }
      });

      await ctx.step('kortix triggers enable and disable edit the local manifest source of truth', async () => {
        requireExit(
          await sandbox.run(['init', 'local-trigger', '-y', '--no-git']),
          0,
          'kortix init for local trigger',
        );
        sandbox.enter('local-trigger');
        requireExit(
          await sandbox.run([
            'triggers',
            'add',
            'daily',
            '--prompt',
            'Daily report',
            '--cron',
            '0 0 3 * * *',
          ]),
          0,
          'kortix triggers add',
        );
        requireExit(await sandbox.run(['triggers', 'enable', 'daily']), 0, 'kortix triggers enable');
        requireExit(await sandbox.run(['triggers', 'disable', 'daily']), 0, 'kortix triggers disable');
        const manifest = sandbox.readFile('kortix.yaml');
        if (!/slug\s*=\s*["']daily["']/.test(manifest) || !/enabled\s*=\s*false/.test(manifest)) {
          throw new Error(`local trigger mutation missing from manifest:\n${manifest}`);
        }
      });
    } finally {
      sandbox.dispose();
    }
  },
);
