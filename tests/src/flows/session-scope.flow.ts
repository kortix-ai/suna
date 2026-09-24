/**
 * Session scope — every session-scoped route resolves the session inside the
 * authorized project, for a caller who may see it, through one guard
 * (`apps/api/src/projects/lib/session-access.ts`). Maps to spec SCOPE-*.
 *
 * All flows run on the local profile: sessions are database rows, and no flow
 * provisions a sandbox.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { FlowContext } from '../core/types';
import { createDatabaseSession } from '../fixtures/database-project';

type Db = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

async function openDb(ctx: FlowContext): Promise<Db> {
  const { Client } = await import('pg');
  const databaseUrl = ctx.env.databaseUrl as string;
  const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const db = new Client({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
  await db.connect();
  return db as unknown as Db;
}

/**
 * A running session with a live sandbox row and a session-bound credential,
 * the shape a sandbox's own KORTIX_TOKEN has. The token is minted as a plain
 * PAT and bound in the database, so it carries no agent grant — the shape of a
 * session in a project that declares no agents.
 */
async function seedBoundSession(
  ctx: FlowContext,
  db: Db,
  project: { id: string; accountId?: string },
  label: string,
): Promise<{ sessionId: string; tokenId: string; token: string }> {
  const ownerUserId = ctx.P.OWNER.userId!;
  const accountId = project.accountId ?? ctx.P.OWNER.accountId!;
  const sessionId = randomUUID();
  const minted = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', { name: `${label} ${sessionId.slice(0, 8)}` });
  minted.status(201);
  const credential = minted.json<{ token_id: string; secret_key: string }>();
  await db.query(
    `INSERT INTO kortix.project_sessions
       (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility)
     VALUES ($1, $2, $3, 'main', 'kortix', 'running', $4, 'private')`,
    [sessionId, accountId, project.id, ownerUserId],
  );
  await db.query(
    `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
     VALUES ($1::uuid, $1, $2, $3, 'active')`,
    [sessionId, accountId, project.id],
  );
  await db.query(
    `UPDATE kortix.account_tokens
        SET account_id = $2, user_id = $3, project_id = $4, session_id = $5
      WHERE token_id = $1`,
    [credential.token_id, accountId, ownerUserId, project.id, sessionId],
  );
  return { sessionId, tokenId: credential.token_id, token: credential.secret_key };
}

async function dropBoundSession(db: Db, seeded: { sessionId: string; tokenId: string } | null) {
  if (!seeded) return;
  await db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [seeded.tokenId]).catch(() => {});
  await db.query('DELETE FROM kortix.session_sandboxes WHERE sandbox_id = $1::uuid', [seeded.sessionId]).catch(() => {});
  await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [seeded.sessionId]).catch(() => {});
}

flow(
  'SCOPE-1',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/environment',
      'POST /v1/projects/:projectId/sessions/:sessionId/environment/stop',
      'POST /v1/projects/:projectId/sessions/:sessionId/environment/ensure',
    ],
  },
  async (ctx) => {
    const db = await openDb(ctx);
    const ownProject = await ctx.fixtures.project();
    const team = await ctx.fixtures.team();
    const teamProject = await team.project();
    const manager = await team.addMember('member');
    await team.grantProjectRole(teamProject.id, manager.userId!, 'manager');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asManager = ctx.client.as(manager);
    const ownSession = await ctx.fixtures.session(ownProject);
    const privateTeamSession = await ctx.fixtures.session(teamProject);
    const seedEnvironment = (sessionId: string, accountId: string, projectId: string) =>
      db.query(
        `INSERT INTO kortix.session_environments (session_id, account_id, project_id, status)
         VALUES ($1, $2::uuid, $3::uuid, 'error')`,
        [sessionId, accountId, projectId],
      );
    const environmentStatus = async (sessionId: string) =>
      (
        await db.query<{ status: string }>(
          'SELECT status FROM kortix.session_environments WHERE session_id = $1',
          [sessionId],
        )
      ).rows[0]?.status;
    try {
      await ctx.step('seed an environment row for a session in each project', async () => {
        await seedEnvironment(ownSession.id, ctx.P.OWNER.accountId!, ownProject.id);
        await seedEnvironment(privateTeamSession.id, team.id, teamProject.id);
      });

      await ctx.step("the session owner reads its environment through the session's project → 200", async () => {
        (
          await owner.get('/v1/projects/:projectId/sessions/:sessionId/environment', {
            params: { projectId: ownProject.id, sessionId: ownSession.id },
          })
        )
          .status(200)
          .body()
          .has('$.session_id', ownSession.id)
          .has('$.status', 'error');
      });

      await ctx.step(
        "a manager of another project reads that session's environment through their own project → 404",
        async () => {
          (
            await asManager.get('/v1/projects/:projectId/sessions/:sessionId/environment', {
              params: { projectId: teamProject.id, sessionId: ownSession.id },
            })
          ).status(404);
        },
      );

      await ctx.step('the same manager stops that environment through their own project → 404, and it is unchanged', async () => {
        (
          await asManager.post(
            '/v1/projects/:projectId/sessions/:sessionId/environment/stop',
            {},
            { params: { projectId: teamProject.id, sessionId: ownSession.id } },
          )
        ).status(404);
        const status = await environmentStatus(ownSession.id);
        if (status !== 'error') throw new Error(`expected the environment to stay "error", got ${status}`);
      });

      await ctx.step('the same manager ensures an environment for that session → 404 before any provisioning', async () => {
        (
          await asManager.post(
            '/v1/projects/:projectId/sessions/:sessionId/environment/ensure',
            {},
            { params: { projectId: teamProject.id, sessionId: ownSession.id } },
          )
        ).status(404);
      });

      await ctx.step("a project manager reads another member's private session environment → 404", async () => {
        (
          await asManager.get('/v1/projects/:projectId/sessions/:sessionId/environment', {
            params: { projectId: teamProject.id, sessionId: privateTeamSession.id },
          })
        ).status(404);
      });

      await ctx.step('the private session owner reads and stops its environment → 200', async () => {
        (
          await owner.get('/v1/projects/:projectId/sessions/:sessionId/environment', {
            params: { projectId: teamProject.id, sessionId: privateTeamSession.id },
          })
        ).status(200);
        (
          await owner.post(
            '/v1/projects/:projectId/sessions/:sessionId/environment/stop',
            {},
            { params: { projectId: teamProject.id, sessionId: privateTeamSession.id } },
          )
        )
          .status(200)
          .body()
          .has('$.status', 'stopped');
      });

      await ctx.step('ensure on a session that does not run on the pi worker → 400 for its owner', async () => {
        (
          await owner.post(
            '/v1/projects/:projectId/sessions/:sessionId/environment/ensure',
            {},
            { params: { projectId: ownProject.id, sessionId: ownSession.id } },
          )
        ).status(400);
      });

      await ctx.step('ANON → 401', async () => {
        (
          await ctx.client.as(ctx.P.ANON).get('/v1/projects/:projectId/sessions/:sessionId/environment', {
            params: { projectId: ownProject.id, sessionId: ownSession.id },
          })
        ).status(401);
      });
    } finally {
      await db
        .query('DELETE FROM kortix.session_environments WHERE session_id = ANY($1::text[])', [
          [ownSession.id, privateTeamSession.id],
        ])
        .catch(() => {});
      await db.end();
    }
  },
);

flow(
  'SCOPE-2',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'POST /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId',
    ],
  },
  async (ctx) => {
    const db = await openDb(ctx);
    const project = await ctx.fixtures.project();
    const accountId = ctx.P.OWNER.accountId!;
    const owner = ctx.client.as(ctx.P.OWNER);
    const backendSessionId = randomUUID();
    const machineSessionId = randomUUID();
    let bound: Awaited<ReturnType<typeof seedBoundSession>> | null = null;
    try {
      await ctx.step('seed a backend-origin session owned by the signed-in owner', async () => {
        await db.query(
          `INSERT INTO kortix.project_sessions
             (session_id, account_id, project_id, branch_name, created_by, visibility, origin)
           VALUES ($1, $2::uuid, $3::uuid, 'session/' || $1, $4::uuid, 'private', 'backend')`,
          [backendSessionId, accountId, project.id, ctx.P.OWNER.userId],
        );
      });

      let backendShareId = '';
      await ctx.step('the signed-in owner lists, mints, and revokes public shares on a backend-origin session', async () => {
        (
          await owner.get('/v1/projects/:projectId/sessions/:sessionId/public-shares', {
            params: { projectId: project.id, sessionId: backendSessionId },
          })
        )
          .status(200)
          .body()
          .has('$.shares', []);
        const minted = await owner.post(
          '/v1/projects/:projectId/sessions/:sessionId/public-shares',
          { preview: { port: 3000 } },
          { params: { projectId: project.id, sessionId: backendSessionId } },
        );
        minted.status(201);
        backendShareId = minted.json<{ share: { share_id: string } }>().share.share_id;
        (
          await owner.del('/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId', {
            params: { projectId: project.id, sessionId: backendSessionId, shareId: backendShareId },
          })
        )
          .status(200)
          .body()
          .exists('$.share.revoked_at');
      });

      await ctx.step('seed a session-bound credential and a machine-owned sibling trigger session', async () => {
        bound = await seedBoundSession(ctx, db, project, 'SCOPE-2');
        await db.query(
          `INSERT INTO kortix.project_sessions
             (session_id, account_id, project_id, branch_name, created_by, visibility, origin, metadata)
           VALUES ($1, $2::uuid, $3::uuid, 'session/' || $1, NULL, 'private', 'trigger',
                   '{"trigger_kind":"git","trigger_slug":"nightly"}'::jsonb)`,
          [machineSessionId, accountId, project.id],
        );
      });

      await ctx.step(
        "a session-bound credential of the account owner cannot mint a public link to a sibling machine-owned session → 403",
        async () => {
          (
            await ctx.client
              .withBearer(bound!.token, 'SESSION_TOKEN')
              .post(
                '/v1/projects/:projectId/sessions/:sessionId/public-shares',
                { preview: { port: 3000 } },
                { params: { projectId: project.id, sessionId: machineSessionId } },
              )
          ).status(403);
          const count = (
            await db.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM kortix.project_session_public_shares WHERE session_id = $1',
              [machineSessionId],
            )
          ).rows[0]?.n;
          if (count !== 0) throw new Error(`expected no public share on the sibling session, found ${count}`);
        },
      );

      await ctx.step('the same credential cannot list the sibling session public shares → 403', async () => {
        (
          await ctx.client.withBearer(bound!.token, 'SESSION_TOKEN').get(
            '/v1/projects/:projectId/sessions/:sessionId/public-shares',
            { params: { projectId: project.id, sessionId: machineSessionId } },
          )
        ).status(403);
      });

      await ctx.step('the same credential mints a public link to its OWN session → 201', async () => {
        (
          await ctx.client
            .withBearer(bound!.token, 'SESSION_TOKEN')
            .post(
              '/v1/projects/:projectId/sessions/:sessionId/public-shares',
              { preview: { port: 3000 } },
              { params: { projectId: project.id, sessionId: bound!.sessionId } },
            )
        ).status(201);
      });

      await ctx.step('the signed-in account owner still mints on the machine-owned session → 201', async () => {
        (
          await owner.post(
            '/v1/projects/:projectId/sessions/:sessionId/public-shares',
            { preview: { port: 3000 } },
            { params: { projectId: project.id, sessionId: machineSessionId } },
          )
        ).status(201);
      });
    } finally {
      await db
        .query('DELETE FROM kortix.project_session_public_shares WHERE session_id = ANY($1::text[])', [
          [backendSessionId, machineSessionId, (bound as { sessionId: string } | null)?.sessionId ?? ''],
        ])
        .catch(() => {});
      await db
        .query('DELETE FROM kortix.project_sessions WHERE session_id = ANY($1::text[])', [[backendSessionId, machineSessionId]])
        .catch(() => {});
      await dropBoundSession(db, bound);
      await db.end();
    }
  },
);

flow(
  'SCOPE-3',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/sessions',
      'PATCH /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id, sessionId: session.id };
    const otherProjectId = randomUUID();

    for (const key of ['legacy_migration', 'slack', 'email', 'telegram', 'teams', 'warm', 'trigger_session_key']) {
      await ctx.step(`PATCH metadata.${key} → 400 (server-managed)`, async () => {
        (
          await owner.patch(
            '/v1/projects/:projectId/sessions/:sessionId',
            { metadata: { [key]: { source_sandbox_id: otherProjectId, channel: 'C0' } } },
            { params },
          )
        )
          .status(400)
          .body()
          .has('$.error', `metadata key is server-managed: ${key}`);
      });
    }

    await ctx.step('PATCH metadata.repository_generation → 400 (server-managed)', async () => {
      (
        await owner.patch(
          '/v1/projects/:projectId/sessions/:sessionId',
          { metadata: { repository_generation: 'generation-other' } },
          { params },
        )
      ).status(400);
    });

    await ctx.step('POST /sessions with metadata.legacy_migration → 400 before any session is created', async () => {
      (
        await owner.post(
          '/v1/projects/:projectId/sessions',
          { metadata: { legacy_migration: { source_sandbox_id: otherProjectId } } },
          { params: { projectId: project.id } },
        )
      )
        .status(400)
        .body()
        .has('$.error', 'metadata key is server-managed: legacy_migration');
    });

    await ctx.step('PATCH a client key → 200, and the session reads it back without any refused key', async () => {
      (
        await owner.patch(
          '/v1/projects/:projectId/sessions/:sessionId',
          { metadata: { kind: 'scope-probe' } },
          { params },
        )
      ).status(200);
      const read = await owner.get('/v1/projects/:projectId/sessions/:sessionId', { params });
      read.status(200).body().has('$.metadata.kind', 'scope-probe');
      const metadata = read.json<{ metadata: Record<string, unknown> }>().metadata;
      for (const key of ['legacy_migration', 'slack', 'email', 'warm']) {
        if (key in metadata) throw new Error(`metadata.${key} must not be stored, got ${JSON.stringify(metadata[key])}`);
      }
    });
  },
);

flow(
  'SCOPE-4',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/sessions/:sessionId/public-shares',
      'GET /v1/public/session-shares/:shareId',
      'GET /v1/public/session-shares/:shareId/messages',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);
    let shareId = '';
    await ctx.step('the owner mints a preview share → 201', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/public-shares',
        { preview: { port: 3000 } },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      r.status(201);
      shareId = r.json<{ share: { share_id: string } }>().share.share_id;
    });
    await ctx.step('anon reads the share metadata → never an auth error', async () => {
      (await anon.get('/v1/public/session-shares/:shareId', { params: { shareId } })).status([200, 503]);
    });
    await ctx.step('anon reads the conversation through the preview share → 404', async () => {
      (await anon.get('/v1/public/session-shares/:shareId/messages', { params: { shareId } }))
        .status(404)
        .body()
        .has('$.error', 'This share does not include the conversation');
    });
  },
);

flow(
  'SCOPE-5',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/cli-token',
      'DELETE /v1/projects/:projectId/cli-token/:tokenId',
    ],
  },
  async (ctx) => {
    const db = await openDb(ctx);
    const project = await ctx.fixtures.project();
    const team = await ctx.fixtures.team();
    const policyProject = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    let bound: Awaited<ReturnType<typeof seedBoundSession>> | null = null;
    const minted: string[] = [];
    try {
      await ctx.step('seed a session-bound credential that carries no agent grant', async () => {
        bound = await seedBoundSession(ctx, db, project, 'SCOPE-5');
      });

      let humanTokenId = '';
      await ctx.step('the signed-in owner mints a project CLI token → 201', async () => {
        const r = await owner.post('/v1/projects/:projectId/cli-token', { name: 'scope-5' }, { params: { projectId: project.id } });
        r.status(201);
        humanTokenId = r.json<{ token_id: string }>().token_id;
        minted.push(humanTokenId);
      });

      await ctx.step('the session-bound credential cannot mint a project CLI token → 403', async () => {
        (
          await ctx.client
            .withBearer(bound!.token, 'SESSION_TOKEN')
            .post('/v1/projects/:projectId/cli-token', { name: 'from-session' }, { params: { projectId: project.id } })
        )
          .status(403)
          .body()
          .has('$.error', 'Agent-session tokens cannot mint project tokens');
      });

      await ctx.step('the session-bound credential cannot revoke a project CLI token → 403', async () => {
        (
          await ctx.client
            .withBearer(bound!.token, 'SESSION_TOKEN')
            .del('/v1/projects/:projectId/cli-token/:tokenId', {
              params: { projectId: project.id, tokenId: humanTokenId },
            })
        ).status(403);
      });

      await ctx.step('an account that requires PAT expiry refuses a project CLI token without one → 400', async () => {
        await db.query(
          'UPDATE kortix.accounts SET pat_require_expiry = true, pat_max_lifetime_days = 30 WHERE account_id = $1::uuid',
          [team.id],
        );
        (
          await owner.post('/v1/projects/:projectId/cli-token', { name: 'no-expiry' }, { params: { projectId: policyProject.id } })
        )
          .status(400)
          .body()
          .has('$.code', 'expiry_required');
      });

      await ctx.step('the same account refuses an expiry beyond its maximum lifetime → 400', async () => {
        const tooFar = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
        (
          await owner.post(
            '/v1/projects/:projectId/cli-token',
            { name: 'too-far', expires_at: tooFar },
            { params: { projectId: policyProject.id } },
          )
        )
          .status(400)
          .body()
          .has('$.code', 'expiry_too_far');
      });

      await ctx.step('the same account mints a project CLI token inside its policy → 201 with that expiry', async () => {
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const r = await owner.post(
          '/v1/projects/:projectId/cli-token',
          { name: 'in-policy', expires_at: expiresAt },
          { params: { projectId: policyProject.id } },
        );
        r.status(201).body().has('$.expires_at', expiresAt);
        minted.push(r.json<{ token_id: string }>().token_id);
      });
    } finally {
      if (minted.length) {
        await db.query('DELETE FROM kortix.account_tokens WHERE token_id = ANY($1::uuid[])', [minted]).catch(() => {});
      }
      await dropBoundSession(db, bound);
      await db.end();
    }
  },
);

async function git(args: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args.join(' ')} failed (${code}): ${err || out}`)),
    );
  });
}

flow(
  'SCOPE-6',
  {
    domain: 'triggers',
    requires: ['database'],
    routes: [
      'POST /v1/accounts/tokens',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
    ],
  },
  async (ctx) => {
    const db = await openDb(ctx);
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const manager = await team.addMember('member');
    await team.grantProjectRole(project.id, manager.userId!, 'manager');
    const owner = ctx.client.as(ctx.P.OWNER);
    const ownerSession = await ctx.fixtures.session(project);
    const otherProject = await ctx.fixtures.project();
    const foreignSessionId = await createDatabaseSession(ctx.env, {
      projectId: otherProject.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
    });
    const trigger = (name: string, sessionId: string) => ({
      name,
      type: 'cron',
      cron: '0 0 3 * * *',
      timezone: 'UTC',
      prompt_template: 'scope probe',
      session_mode: 'pinned',
      session_id: sessionId,
    });
    const workDir = await mkdtemp(join(tmpdir(), 'ke2e-scope-'));
    const tokenIds: string[] = [];
    try {
      await ctx.step("a project manager cannot pin a trigger to another member's private session → 400", async () => {
        (
          await ctx.client
            .as(manager)
            .post('/v1/projects/:projectId/triggers', trigger('Manager Pin', ownerSession.id), {
              params: { projectId: project.id },
            })
        ).status(400);
      });

      await ctx.step('the session owner pins a trigger to their own session → 201', async () => {
        (
          await owner.post('/v1/projects/:projectId/triggers', trigger('Owner Pin', ownerSession.id), {
            params: { projectId: project.id },
          })
        ).status(201);
      });

      await ctx.step("a manifest commit re-pins the trigger to another project's session", async () => {
        const [row] = (
          await db.query<{ repo_url: string }>('SELECT repo_url FROM kortix.projects WHERE project_id = $1::uuid', [
            project.id,
          ])
        ).rows;
        if (!row?.repo_url) throw new Error('project has no repository');
        // Local target: the fixture repository is a bare repository on disk.
        // Deployed target: the managed repository is private, so clone and
        // push through the Kortix Git proxy with an owner PAT (the same path
        // as AgentPrincipalsWorld.commitToMain).
        let remote = row.repo_url;
        let auth: Record<string, string> = {};
        if (!row.repo_url.startsWith('/')) {
          const minted = await owner.post('/v1/accounts/tokens', {
            name: ctx.fixtures.name('scope6-manifest-writer'),
            account_id: team.id,
          });
          minted.status(201);
          const { token_id: tokenId, secret_key: secret } = minted.json<{ token_id: string; secret_key: string }>();
          tokenIds.push(tokenId);
          remote = `${ctx.env.apiUrl.replace(/\/v1$/, '')}/v1/git/${project.id}`;
          auth = {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}`,
          };
        }
        await git(['clone', '--quiet', '--branch', 'main', remote, workDir], undefined, auth);
        await git(['config', 'user.name', 'Kortix Local E2E'], workDir);
        await git(['config', 'user.email', 'local-e2e@kortix.test'], workDir);
        const manifestPath = join(workDir, 'kortix.yaml');
        const manifest = await readFile(manifestPath, 'utf8');
        if (!manifest.includes(ownerSession.id)) throw new Error('the trigger commit did not pin the owner session');
        await writeFile(manifestPath, manifest.split(ownerSession.id).join(foreignSessionId));
        await git(['commit', '--quiet', '-am', 'repin trigger'], workDir);
        await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], workDir, auth);
      });

      await ctx.step('reading the triggers records no pinned session for the foreign id', async () => {
        // The API reads the manifest through its git mirror; wait until the
        // listing reflects the re-pin commit.
        await waitFor(
          async () => {
            const listed = await owner.get('/v1/projects/:projectId/triggers', { params: { projectId: project.id } });
            listed.status(200);
            return listed.json<{ triggers: Array<{ slug: string; session_id: string | null }> }>().triggers;
          },
          {
            until: (triggers) => triggers.some((t) => t.slug === 'owner-pin' && t.session_id === foreignSessionId),
            timeoutMs: 90_000,
            intervalMs: 2_000,
            description: 'trigger listing reflects the re-pin commit',
          },
        );
        const [runtime] = (
          await db.query<{ session_id: string | null }>(
            `SELECT session_id FROM kortix.project_trigger_runtime WHERE project_id = $1::uuid AND slug = 'owner-pin'`,
            [project.id],
          )
        ).rows;
        if (!runtime) throw new Error('trigger runtime row missing after the manifest read');
        if (runtime.session_id !== null) {
          throw new Error(
            `runtime row must name no session, got ${runtime.session_id} (foreign ${foreignSessionId}, own ${ownerSession.id})`,
          );
        }
      });

      await ctx.step("firing the trigger never queues a prompt into the other project's session", async () => {
        const fired = await owner.post(
          '/v1/projects/:projectId/triggers/:slug/fire',
          {},
          { params: { projectId: project.id, slug: 'owner-pin' } },
        );
        const body = fired.json<{ session_id?: string | null }>() ?? {};
        if (body.session_id === foreignSessionId) {
          throw new Error(`fire queued into the foreign session: ${fired.text()}`);
        }
        const queued = (
          await db.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM kortix.session_lifecycle_commands WHERE session_id = $1',
            [foreignSessionId],
          )
        ).rows[0]?.n;
        if (queued !== 0) throw new Error(`expected no command for the foreign session, found ${queued}`);
      });
    } finally {
      await db
        .query('DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ANY($1::text[])', [
          [foreignSessionId, ownerSession.id],
        ])
        .catch(() => {});
      for (const tokenId of tokenIds) {
        await db.query('DELETE FROM kortix.account_tokens WHERE token_id = $1', [tokenId]).catch(() => {});
      }
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      await db.end();
    }
  },
);
