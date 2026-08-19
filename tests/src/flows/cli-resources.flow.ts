/**
 * Real-process coverage for the project-scoped CLI resource commands.
 *
 * Each command starts apps/cli/src/index.ts in an isolated process. The flows
 * assert exit status, JSON/stdout, local files, and API read-back state.
 */
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
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
      'GET /v1/projects',
      'GET /v1/projects/:projectId',
      'DELETE /v1/projects/:projectId',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const sandbox = await authenticatedCli(ctx, 'projects');
    try {
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

      await ctx.step('kortix projects link and unlink write and remove .kortix/link.json', async () => {
        requireExit(
          await sandbox.run(['init', 'linked', '-y', '--no-git']),
          0,
          'kortix init',
        );
        sandbox.enter('linked');
        requireExit(await sandbox.run(['projects', 'link', project.id]), 0, 'kortix projects link');
        const link = JSON.parse(sandbox.readFile('.kortix/link.json')) as { project_id: string };
        if (link.project_id !== project.id) throw new Error(`link points at ${link.project_id}`);
        requireExit(await sandbox.run(['projects', 'unlink']), 0, 'kortix projects unlink');
        if (sandbox.exists('.kortix/link.json')) throw new Error('projects unlink left link.json behind');
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
    // Raised from 180_000 because THIS change added two bounded 75s mirror-TTL
    // polls above; 180s could no longer contain them plus the 120s fire budget.
    // Not a general timeout tuning pass — only the arithmetic this fix forces.
    timeoutMs: 420_000,
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
        // Triggers are git-manifest-backed. Each API replica serves `triggers ls`
        // from its own in-process mirror cache, refreshed at most every
        // KORTIX_GIT_REFRESH_INTERVAL_MS (default 60_000 —
        // apps/api/src/projects/git/mirror.ts refreshIntervalMs/lastRefreshAt).
        // The POST above may be served by one replica and this GET by a sibling,
        // so a just-created trigger is legitimately invisible for up to 60s on a
        // multi-replica deployment. Poll past one full refresh window instead of
        // asserting once.
        await waitFor(
          async () =>
            parseJson<{ triggers: Array<{ slug: string }> }>(
              await sandbox.run(['triggers', 'ls', '--project', project.id, '--json']),
              'kortix triggers ls',
            ),
          {
            until: (list) => list.triggers.some((item) => item.slug === slug),
            timeoutMs: 75_000,
            intervalMs: 3_000,
            description: `trigger ${slug} to appear in \`kortix triggers ls\``,
          },
        );
        // `triggers info` reads the same per-replica mirror, so it can still be
        // routed to a replica that has not refreshed yet. Same bounded wait.
        const info = await waitFor(
          async () =>
            parseJson<{ slug: string }>(
              await sandbox.run(['triggers', 'info', slug, '--project', project.id, '--json']),
              'kortix triggers info',
            ),
          {
            until: (row) => row.slug === slug,
            timeoutMs: 75_000,
            intervalMs: 3_000,
            description: `\`kortix triggers info ${slug}\` to resolve the trigger`,
            retryOnError: () => true,
          },
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
        // The CLI writes YAML, not TOML: `kortix init` scaffolds kortix.yaml and
        // apps/cli/src/manifest-edit.ts mutates it through the `yaml` Document
        // API. The real block `kortix triggers add`/`disable` produces is:
        //     - slug: daily
        //       type: cron
        //       enabled: false
        // The old assertions were TOML (`slug = "daily"`), which YAML never matches.
        const manifest = sandbox.readFile('kortix.yaml');
        const manifestLines = manifest.split(/\r?\n/);
        const blockStart = manifestLines.findIndex((line) =>
          /^\s*-\s+slug:\s*["']?daily["']?\s*$/.test(line),
        );
        if (blockStart === -1) {
          throw new Error(`kortix triggers add did not write a \`- slug: daily\` block:\n${manifest}`);
        }
        // Scope `enabled` to the daily block. The scaffold ships another, ENABLED
        // trigger (harness-reflector) plus commented-out examples, so an
        // unscoped /enabled:\s*false/ would not prove which trigger got disabled.
        const afterStart = manifestLines.slice(blockStart + 1);
        const blockEnd = afterStart.findIndex((line) => /^\s*-\s+\S/.test(line));
        const dailyBlock = (blockEnd === -1 ? afterStart : afterStart.slice(0, blockEnd)).join('\n');
        if (!/^\s*enabled:\s*false\s*$/m.test(dailyBlock)) {
          throw new Error(
            `kortix triggers disable did not set \`enabled: false\` on the daily trigger:\n${dailyBlock}`,
          );
        }
      });
    } finally {
      sandbox.dispose();
    }
  },
);
