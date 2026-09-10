/**
 * Spaces — named containers inside a project. Maps to spec §12b
 * (SPACE-1..6). Each space is a `spaces.<slug>` block of the root manifest
 * (user, 2026-09-08) — the source of truth for identity/agent/sessions-mode
 * and for the agents it owns; the database holds only the session join
 * (`project_sessions.space`) and the IAM grants (generic
 * `resource-grants`, `resource_type: 'space'`).
 *
 * Every CRUD write commits that one file, exactly like triggers next door
 * (triggers.flow.ts) — projects here use `managedGit: true` so the commit is
 * real and readable back through `GET /projects/:id/commits`.
 *
 * The local profile cannot provision a real session (`503
 * KORTIX_URL_UNREACHABLE` — see marketplace.flow.ts MKTP-11's precedent), so
 * `POST /sessions {space}` is asserted at the space
 * validation/authorization boundary only: SPACE-2 proves the 400
 * `SPACE_NOT_DECLARED` and 403 `space_not_accessible` gates fire
 * (and stop firing once granted), never that a session actually starts.
 */
import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';
import { CliSandbox, throwIfCliInfraFailure, type CliResult } from '../fixtures/cli';
import { commitFileToLocalRepository } from '../fixtures/local-git';

type FlowContext = Parameters<Parameters<typeof flow>[2]>[0];

async function enableSpaces(ctx: FlowContext, projectId: string): Promise<void> {
  await ctx.step('OWNER enables the Spaces feature flag', async () => {
    const response = await ctx.client.as(ctx.P.OWNER).patch(
      '/v1/projects/:projectId/features',
      { feature: 'spaces', enabled: true },
      { params: { projectId } },
    );
    response.status(200);
  });
}

// ─── SPACE-1 — CRUD + manifest commit ────────────────────────────────────────

flow(
  'SPACE-1',
  {
    domain: 'spaces',
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'GET /v1/projects/:projectId/spaces',
      'POST /v1/projects/:projectId/spaces',
      'GET /v1/projects/:projectId/spaces/:slug',
      'PATCH /v1/projects/:projectId/spaces/:slug',
      'DELETE /v1/projects/:projectId/spaces/:slug',
      'GET /v1/projects/:projectId/commits',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    await enableSpaces(ctx, p.id);

    await ctx.step('OWNER creates "Marketing" → 201, slug derived, defaults', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Marketing' },
        { params: { projectId: p.id } },
      );
      r.status(201)
        .body()
        .has('$.slug', 'marketing')
        .has('$.name', 'Marketing')
        .has('$.sessions', 'private')
        .has('$.description', null)
        .has('$.agent', null)
        .has('$.session_count', 0)
        .has('$.trigger_count', 0)
        .has('$.can_manage', true)
        .has('$.path', 'kortix.yaml');
      const body = r.json<any>();
      if (!Array.isArray(body.agents) || body.agents.length !== 0) {
        throw new Error(`expected agents: [] on create, got ${JSON.stringify(body.agents)}`);
      }
    });

    await ctx.step('the create committed kortix.yaml (readable via GET /commits)', async () => {
      const r = await owner.get('/v1/projects/:projectId/commits', { params: { projectId: p.id } });
      r.status(200);
      const body = r.json<any>();
      const subjects = (body.commits ?? []).map((c: any) => c.subject as string);
      if (!subjects.some((s: string) => s.includes('feat(spaces): add marketing'))) {
        throw new Error(`expected a "feat(spaces): add marketing" commit, got: ${JSON.stringify(subjects)}`);
      }
    });

    await ctx.step('GET list includes it', async () => {
      const r = await owner.get('/v1/projects/:projectId/spaces', { params: { projectId: p.id } });
      r.status(200);
      const body = r.json<any>();
      if (!body.spaces.some((s: any) => s.slug === 'marketing')) {
        throw new Error(`list omitted marketing: ${r.text()}`);
      }
    });

    await ctx.step('GET one returns it', async () => {
      const r = await owner.get('/v1/projects/:projectId/spaces/:slug', {
        params: { projectId: p.id, slug: 'marketing' },
      });
      r.status(200).body().has('$.slug', 'marketing');
    });

    await ctx.step('PATCH description + sessions:shared → 200, persisted', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/spaces/:slug',
        { description: 'Campaign work.', sessions: 'shared' },
        { params: { projectId: p.id, slug: 'marketing' } },
      );
      r.status(200).body().has('$.description', 'Campaign work.').has('$.sessions', 'shared');
    });

    // The 2026-09-07 simplification: neither field is a space field any
    // more, and the route refuses what it does not know rather than storing it.
    await ctx.step('PATCH instructions or context → 400 (both fields are gone)', async () => {
      for (const body of [{ instructions: 'British English.' }, { context: ['docs/brand.md'] }]) {
        const r = await owner.patch('/v1/projects/:projectId/spaces/:slug', body, {
          params: { projectId: p.id, slug: 'marketing' },
        });
        r.status(400);
      }
    });

    await ctx.step('PATCH {} → 200, no manifest commit', async () => {
      const before = (
        await owner.get('/v1/projects/:projectId/commits', { params: { projectId: p.id } })
      ).json<any>();
      const r = await owner.patch(
        '/v1/projects/:projectId/spaces/:slug',
        {},
        { params: { projectId: p.id, slug: 'marketing' } },
      );
      r.status(200);
      const after = (
        await owner.get('/v1/projects/:projectId/commits', { params: { projectId: p.id } })
      ).json<any>();
      if ((after.commits?.length ?? 0) !== (before.commits?.length ?? 0)) {
        throw new Error(
          `PATCH {} committed — before ${before.commits?.length}, after ${after.commits?.length}`,
        );
      }
    });

    await ctx.step('duplicate slug → 409 SPACE_SLUG_TAKEN', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Marketing' },
        { params: { projectId: p.id } },
      );
      r.status(409).body().has('$.code', 'SPACE_SLUG_TAKEN');
    });

    await ctx.step('unknown agent → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Ghost Agent', agent: 'no-such-agent' },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('invalid slug → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Bad Slug', slug: 'Not A Slug!' },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('bad sessions mode → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Bad Sessions', sessions: 'public' },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('DELETE → 200, then GET → 404', async () => {
      const del = await owner.del('/v1/projects/:projectId/spaces/:slug', {
        params: { projectId: p.id, slug: 'marketing' },
      });
      del.status(200).body().has('$.ok', true);
      const get = await owner.get('/v1/projects/:projectId/spaces/:slug', {
        params: { projectId: p.id, slug: 'marketing' },
      });
      get.status(404);
    });
  },
);

// ─── SPACE-2 — authz: closed by default, granted via resource-grants ────────

flow(
  'SPACE-2',
  {
    domain: 'spaces',
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'GET /v1/projects/:projectId/spaces',
      'POST /v1/projects/:projectId/spaces',
      'GET /v1/projects/:projectId/spaces/:slug',
      'PATCH /v1/projects/:projectId/spaces/:slug',
      'DELETE /v1/projects/:projectId/spaces/:slug',
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/resource-grants',
      'GET /v1/projects/:projectId/resource-grants',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    await enableSpaces(ctx, project.id);
    const member = await team.addMember('member');
    if (!member.userId) throw new Error('SPACE-2 member fixture has no user id');
    await team.grantProjectRole(project.id, member.userId, 'member');
    const asMember = ctx.client.as(member);

    await ctx.step('OWNER declares the "marketing" space', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Marketing' },
        { params: { projectId: project.id } },
      );
      r.status(201);
    });

    await ctx.step('member with NO grant → list is empty (closed by default)', async () => {
      const r = await asMember.get('/v1/projects/:projectId/spaces', {
        params: { projectId: project.id },
      });
      r.status(200).body().has('$.spaces', []);
    });

    await ctx.step('member with NO grant → GET one → 404 (undeclared and inaccessible are the same answer)', async () => {
      const r = await asMember.get('/v1/projects/:projectId/spaces/:slug', {
        params: { projectId: project.id, slug: 'marketing' },
      });
      r.status(404);
    });

    await ctx.step('member with NO grant → session create with this space → 403 space_not_accessible', async () => {
      const r = await asMember.post(
        '/v1/projects/:projectId/sessions',
        { space: 'marketing', initial_prompt: 'noop' },
        { params: { projectId: project.id } },
      );
      r.status(403)
        .body()
        .has('$.code', 'space_not_accessible')
        .has('$.accessible_spaces', []);
    });

    let grantId = '';
    await ctx.step('OWNER grants the space to the member → 201', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/resource-grants',
        {
          resource_type: 'space',
          resource_id: 'marketing',
          principal_type: 'member',
          principal_id: member.userId,
        },
        { params: { projectId: project.id } },
      );
      r.status(201)
        .body()
        .has('$.resource_type', 'space')
        .has('$.resource_id', 'marketing');
      grantId = r.json<any>().grant_id;
    });

    await ctx.step('member now lists + reads it', async () => {
      const list = await asMember.get('/v1/projects/:projectId/spaces', {
        params: { projectId: project.id },
      });
      list.status(200);
      if (!list.json<any>().spaces.some((s: any) => s.slug === 'marketing')) {
        throw new Error(`list still omits marketing after the grant: ${list.text()}`);
      }
      const get = await asMember.get('/v1/projects/:projectId/spaces/:slug', {
        params: { projectId: project.id, slug: 'marketing' },
      });
      get.status(200);
    });

    await ctx.step(
      'member now clears the SPACE gate on session create (never the 403 space_not_accessible)',
      async () => {
        const r = await asMember.post(
          '/v1/projects/:projectId/sessions',
          { space: 'marketing', initial_prompt: 'noop' },
          { params: { projectId: project.id } },
        );
        if (r.statusCode === 403 && r.json<any>()?.code === 'space_not_accessible') {
          throw new Error(`still denied by the space gate after a grant: ${r.text()}`);
        }
        // Whatever boundary the local profile hits NEXT (no real sandbox
        // provider configured) is not this flow's contract — documented, not
        // asserted, per MKTP-11's precedent.
      },
    );

    await ctx.step('GET /resource-grants shows the space resource + the grant', async () => {
      const r = await owner.get('/v1/projects/:projectId/resource-grants', {
        params: { projectId: project.id },
      });
      r.status(200);
      const body = r.json<any>();
      if (!body.resources.spaces.some((s: any) => s.id === 'marketing')) {
        throw new Error(`resources.spaces omits marketing: ${JSON.stringify(body.resources)}`);
      }
      if (
        !body.grants.some(
          (g: any) => g.grant_id === grantId && g.resource_type === 'space' && g.resource_id === 'marketing',
        )
      ) {
        throw new Error(`grants list omits the space grant: ${JSON.stringify(body.grants)}`);
      }
    });

    await ctx.step('member PATCH → 403 (no project.customize.write)', async () => {
      const r = await asMember.patch(
        '/v1/projects/:projectId/spaces/:slug',
        { description: 'nope' },
        { params: { projectId: project.id, slug: 'marketing' } },
      );
      r.status(403);
    });

    await ctx.step('member DELETE → 403', async () => {
      const r = await asMember.del('/v1/projects/:projectId/spaces/:slug', {
        params: { projectId: project.id, slug: 'marketing' },
      });
      r.status(403);
    });

    await ctx.step('session create naming an UNDECLARED space → 400 SPACE_NOT_DECLARED', async () => {
      const r = await asMember.post(
        '/v1/projects/:projectId/sessions',
        { space: 'nope', initial_prompt: 'noop' },
        { params: { projectId: project.id } },
      );
      r.status(400).body().has('$.code', 'SPACE_NOT_DECLARED');
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/spaces', { params: { projectId: project.id } });
      r.status(401);
    });
  },
);

// ─── SPACE-3 — sessions filter/hiding + sessions:shared visibility ──────────

flow(
  'SPACE-3',
  {
    domain: 'spaces',
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'POST /v1/projects/:projectId/spaces',
      'POST /v1/projects/:projectId/resource-grants',
      'GET /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    await enableSpaces(ctx, project.id);
    const member1 = await team.addMember('member');
    const member2 = await team.addMember('member');
    if (!member1.userId || !member2.userId) throw new Error('SPACE-3 members have no user id');
    await team.grantProjectRole(project.id, member1.userId, 'member');
    await team.grantProjectRole(project.id, member2.userId, 'member');
    const asMember1 = ctx.client.as(member1);

    await ctx.step('OWNER declares a private space "research" and a shared one "open-desk"', async () => {
      const priv = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Research' },
        { params: { projectId: project.id } },
      );
      priv.status(201).body().has('$.sessions', 'private');
      const shared = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Open Desk', sessions: 'shared' },
        { params: { projectId: project.id } },
      );
      shared.status(201).body().has('$.sessions', 'shared');
    });

    // member1's OWN session, seeded directly (the local profile cannot
    // provision a real session — see marketplace.flow.ts MKTP-11).
    await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: member1.userId,
      visibility: 'private',
      space: 'research',
    });
    // member2's session in the SHARED space — private visibility, but
    // `sessions: shared` opens it to everyone granted the space.
    await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: member2.userId,
      visibility: 'private',
      space: 'open-desk',
    });

    await ctx.step('member1 WITHOUT a grant on "research" cannot see even their OWN row in it', async () => {
      const r = await asMember1.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { space: 'research' },
      });
      r.status(200).body().has('$', []);
    });

    await ctx.step('OWNER grants member1 "research"', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/resource-grants',
        {
          resource_type: 'space',
          resource_id: 'research',
          principal_type: 'member',
          principal_id: member1.userId,
        },
        { params: { projectId: project.id } },
      );
      r.status(201);
    });

    await ctx.step('member1 now sees their own row inside "research"', async () => {
      const r = await asMember1.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { space: 'research' },
      });
      r.status(200);
      if (r.json<any>().length !== 1) {
        throw new Error(`expected exactly 1 session after the grant, got: ${r.text()}`);
      }
    });

    await ctx.step('member1 WITHOUT a grant on "open-desk" cannot see member2\'s row', async () => {
      const r = await asMember1.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { space: 'open-desk' },
      });
      r.status(200).body().has('$', []);
    });

    await ctx.step('OWNER grants member1 "open-desk"', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/resource-grants',
        {
          resource_type: 'space',
          resource_id: 'open-desk',
          principal_type: 'member',
          principal_id: member1.userId,
        },
        { params: { projectId: project.id } },
      );
      r.status(201);
    });

    await ctx.step('sessions:shared now exposes member2\'s (private, not-mine) row to member1', async () => {
      const r = await asMember1.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { space: 'open-desk' },
      });
      r.status(200);
      if (r.json<any>().length !== 1) {
        throw new Error(`expected member2's row via sessions:shared, got: ${r.text()}`);
      }
    });

    await ctx.step('?space=<slug> and ?space= (none) are both accepted → 200 arrays', async () => {
      const withSlug = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { space: 'research' },
      });
      withSlug.status(200);
      if (!Array.isArray(withSlug.json())) throw new Error('?space=<slug> did not return an array');

      const none = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { space: '' },
      });
      none.status(200);
      if (!Array.isArray(none.json())) throw new Error('?space= did not return an array');
    });
  },
);

// ─── SPACE-4 — triggers carry a space back-reference ───────────────────

flow(
  'SPACE-4',
  {
    domain: 'spaces',
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'POST /v1/projects/:projectId/spaces',
      'DELETE /v1/projects/:projectId/spaces/:slug',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    await enableSpaces(ctx, p.id);

    await ctx.step('OWNER declares the "ops" space', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/spaces',
        { name: 'Ops' },
        { params: { projectId: p.id } },
      );
      r.status(201);
    });

    await ctx.step('POST trigger with space → 201, GET shows it', async () => {
      const created = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Ops Trigger',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
          space: 'ops',
        },
        { params: { projectId: p.id } },
      );
      created.status(201).body().has('triggers[0].space', 'ops');
    });

    await ctx.step('POST trigger with an UNDECLARED space → 400 SPACE_NOT_DECLARED', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Bad Trigger',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
          space: 'no-such-space',
        },
        { params: { projectId: p.id } },
      );
      r.status(400).body().has('$.code', 'SPACE_NOT_DECLARED');
    });

    await ctx.step('PATCH an unrelated field ({enabled:false}) keeps space', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { enabled: false },
        { params: { projectId: p.id, slug: 'ops-trigger' } },
      );
      r.status(200).body().has('triggers[0].space', 'ops');
    });

    await ctx.step('PATCH {space:null} clears it', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { space: null },
        { params: { projectId: p.id, slug: 'ops-trigger' } },
      );
      r.status(200).body().has('triggers[0].space', null);
    });

    await ctx.step('re-attach the space, then delete it — the trigger loses the back-reference', async () => {
      const patched = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { space: 'ops' },
        { params: { projectId: p.id, slug: 'ops-trigger' } },
      );
      patched.status(200).body().has('triggers[0].space', 'ops');

      const deleted = await owner.del('/v1/projects/:projectId/spaces/:slug', {
        params: { projectId: p.id, slug: 'ops' },
      });
      deleted.status(200);

      const list = await owner.get('/v1/projects/:projectId/triggers', { params: { projectId: p.id } });
      list.status(200).body().has('triggers[0].space', null);
    });
  },
);

// ─── SPACE-5 — CLI as real processes ─────────────────────────────────────────

function requireExit(result: CliResult, expected: number, action: string): void {
  if (expected === 0) throwIfCliInfraFailure(result, action);
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
  const login = await sandbox.login(pat, { noProject: true, account: ctx.P.OWNER.accountId });
  requireExit(login, 0, 'kortix login');
  return sandbox;
}

flow(
  'SPACE-5',
  {
    domain: 'spaces',
    routes: [
      'GET /v1/accounts/me',
      'PATCH /v1/projects/:projectId/features',
      'GET /v1/projects/:projectId/spaces',
      'POST /v1/projects/:projectId/spaces',
      'GET /v1/projects/:projectId/spaces/:slug',
      'PATCH /v1/projects/:projectId/spaces/:slug',
      'DELETE /v1/projects/:projectId/spaces/:slug',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ managedGit: true });
    await enableSpaces(ctx, project.id);
    const sandbox = await authenticatedCli(ctx, 'spaces');
    try {
      await ctx.step('kortix spaces create "Marketing" --json → 201, slug derived', async () => {
        const created = parseJson<{ slug: string; name: string }>(
          await sandbox.run([
            'spaces',
            'create',
            'Marketing',
            '--description',
            'd',
            '--project',
            project.id,
            '--json',
          ]),
          'kortix spaces create',
        );
        if (created.slug !== 'marketing') throw new Error(`expected slug "marketing", got ${created.slug}`);
      });

      await ctx.step('kortix spaces ls --json contains it', async () => {
        const list = parseJson<{ spaces: Array<{ slug: string }> }>(
          await sandbox.run(['spaces', 'ls', '--project', project.id, '--json']),
          'kortix spaces ls',
        );
        if (!list.spaces.some((s) => s.slug === 'marketing')) {
          throw new Error(`ls omitted marketing: ${JSON.stringify(list)}`);
        }
      });

      await ctx.step('kortix spaces show marketing --json', async () => {
        const shown = parseJson<{ slug: string }>(
          await sandbox.run(['spaces', 'show', 'marketing', '--project', project.id, '--json']),
          'kortix spaces show',
        );
        if (shown.slug !== 'marketing') throw new Error(`show returned ${shown.slug}`);
      });

      await ctx.step('kortix spaces update marketing --sessions shared --json', async () => {
        const updated = parseJson<{ sessions: string }>(
          await sandbox.run([
            'spaces',
            'update',
            'marketing',
            '--sessions',
            'shared',
            '--project',
            project.id,
            '--json',
          ]),
          'kortix spaces update',
        );
        if (updated.sessions !== 'shared') throw new Error(`update did not persist sessions:shared`);
      });

      await ctx.step('kortix spaces rm marketing --yes → 0, then show fails', async () => {
        requireExit(
          await sandbox.run(['spaces', 'rm', 'marketing', '--project', project.id, '--yes']),
          0,
          'kortix spaces rm',
        );
        const shown = await sandbox.run(['spaces', 'show', 'marketing', '--project', project.id, '--json']);
        requireExit(shown, 1, 'kortix spaces show after rm');
      });
    } finally {
      sandbox.dispose();
    }
  },
);

// ─── SPACE-6 — space-owned agents: usable where declared or referenced ──
//
// No API route writes an `agents:` block into a space file (that is an
// authoring act in git), so the files are committed straight into the local
// bare repository. An API write follows the seeding, because it invalidates
// the project's git mirror — the mirror otherwise re-fetches on a
// `KORTIX_GIT_REFRESH_INTERVAL_MS` (60s) cadence.
flow(
  'SPACE-6',
  {
    domain: 'spaces',
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'POST /v1/projects/:projectId/spaces',
      'GET /v1/projects/:projectId/spaces/:slug',
      'GET /v1/projects/:projectId/detail',
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/triggers',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    if (!p.repoUrl) throw new Error('SPACE-6 needs the local git repository of a managedGit project');
    const repoUrl = p.repoUrl;
    const owner = ctx.client.as(ctx.P.OWNER);
    await enableSpaces(ctx, p.id);

    await ctx.step(
      'spaces.marketing declares agent "writer"; spaces.sales references it with { from: marketing }',
      async () => {
        // ONE commit to ONE file now — both spaces live in the root manifest,
        // so a state that used to need two ordered commits is a single write.
        await commitFileToLocalRepository(
          repoUrl,
          'kortix.yaml',
          [
            'kortix_version: 2',
            'project:',
            `  name: ${p.name}`,
            'default_agent: kortix',
            'agents:',
            '  kortix: {}',
            'spaces:',
            '  marketing:',
            '    name: Marketing',
            '    agent: writer',
            '    agents:',
            '      writer:',
            '        connectors: []',
            '  sales:',
            '    name: Sales',
            '    agents:',
            '      writer:',
            '        from: marketing',
            '',
          ].join('\n'),
          'feat: marketing owns writer, sales borrows it',
        );
        // The API write that refreshes the mirror.
        const r = await owner.post(
          '/v1/projects/:projectId/spaces',
          { name: 'Ops' },
          { params: { projectId: p.id } },
        );
        r.status(201);
      },
    );

    await ctx.step(
      'GET one lists the agents usable there; the project roster marks writer as owned by marketing',
      async () => {
        const read = async (slug: string) => {
          const r = await owner.get('/v1/projects/:projectId/spaces/:slug', {
            params: { projectId: p.id, slug },
          });
          r.status(200);
          return r.json<any>();
        };
        const marketing = await read('marketing');
        if (marketing.path !== 'kortix.yaml' || marketing.agent !== 'writer') {
          throw new Error(`unexpected marketing: ${JSON.stringify(marketing)}`);
        }
        const usable = {
          marketing: marketing.agents,
          sales: (await read('sales')).agents,
          ops: (await read('ops')).agents,
        };
        const expected = { marketing: ['writer'], sales: ['writer'], ops: [] };
        if (JSON.stringify(usable) !== JSON.stringify(expected)) {
          throw new Error(`unexpected usable agents: ${JSON.stringify(usable)}`);
        }
        const detail = await owner.get('/v1/projects/:projectId/detail', {
          params: { projectId: p.id },
        });
        detail.status(200);
        const roster: Array<{ name: string; space?: string | null }> =
          detail.json<any>().config?.agents ?? [];
        const owners = Object.fromEntries(roster.map((a) => [a.name, a.space ?? null]));
        if (owners.writer !== 'marketing' || owners.kortix !== null) {
          throw new Error(
            `expected writer owned by marketing and kortix global, got ${JSON.stringify(owners)}`,
          );
        }
      },
    );

    await ctx.step(
      'session create at the project level with "writer" → 400 AGENT_NOT_IN_SPACE, naming the usable agents',
      async () => {
        const r = await owner.post(
          '/v1/projects/:projectId/sessions',
          { agent_name: 'writer' },
          { params: { projectId: p.id } },
        );
        r.status(400).body().has('$.code', 'AGENT_NOT_IN_SPACE');
        const usable = r.json<any>().usable_agents;
        if (JSON.stringify(usable) !== JSON.stringify(['kortix'])) {
          throw new Error(`expected usable_agents ['kortix'], got ${JSON.stringify(usable)}`);
        }
      },
    );

    await ctx.step(
      'with "writer" inside marketing (owner) and sales (reference) the scope gate passes; inside ops it refuses',
      async () => {
        for (const space of ['marketing', 'sales']) {
          const r = await owner.post(
            '/v1/projects/:projectId/sessions',
            { agent_name: 'writer', space },
            { params: { projectId: p.id } },
          );
          // The local profile cannot boot a session (no sandbox provider): the
          // assertion is that the NEXT boundary is not this gate.
          if (r.json<any>()?.code === 'AGENT_NOT_IN_SPACE') {
            throw new Error(`writer must be usable inside ${space}: ${JSON.stringify(r.json())}`);
          }
        }
        const refused = await owner.post(
          '/v1/projects/:projectId/sessions',
          { agent_name: 'writer', space: 'ops' },
          { params: { projectId: p.id } },
        );
        refused.status(400).body().has('$.code', 'AGENT_NOT_IN_SPACE');
      },
    );

    await ctx.step(
      "a send into marketing with no agent fills in its own default writer and passes the gate",
      async () => {
        const r = await owner.post(
          '/v1/projects/:projectId/sessions',
          { space: 'marketing' },
          { params: { projectId: p.id } },
        );
        if (r.json<any>()?.code === 'AGENT_NOT_IN_SPACE') {
          throw new Error(`marketing's own default must be usable there: ${JSON.stringify(r.json())}`);
        }
      },
    );

    await ctx.step(
      'a trigger naming "writer" without a space → 400 AGENT_NOT_IN_SPACE; with space marketing → 201',
      async () => {
        const bad = await owner.post(
          '/v1/projects/:projectId/triggers',
          { name: 'Weekly', type: 'cron', cron: '0 0 9 * * 1', prompt_template: 'x', agent: 'writer' },
          { params: { projectId: p.id } },
        );
        bad.status(400).body().has('$.code', 'AGENT_NOT_IN_SPACE');
        const ok = await owner.post(
          '/v1/projects/:projectId/triggers',
          {
            name: 'Weekly',
            type: 'cron',
            cron: '0 0 9 * * 1',
            prompt_template: 'x',
            agent: 'writer',
            space: 'marketing',
          },
          { params: { projectId: p.id } },
        );
        ok.status(201);
      },
    );
  },
);

// ─── SPACE-7 — moving a session between spaces ─────────────────────────

flow(
  'SPACE-7',
  {
    domain: 'spaces',
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'POST /v1/projects/:projectId/spaces',
      'POST /v1/projects/:projectId/resource-grants',
      'PATCH /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    await enableSpaces(ctx, project.id);
    const ownerId = ctx.P.OWNER.userId;
    if (!ownerId) throw new Error('SPACE-7 needs the owner user id');
    const member = await team.addMember('member');
    const memberId = member.userId;
    if (!memberId) throw new Error('SPACE-7 member has no user id');
    await team.grantProjectRole(project.id, memberId, 'member');
    const asMember = ctx.client.as(member);

    await ctx.step('OWNER declares "research" and "open-desk"', async () => {
      (
        await owner.post(
          '/v1/projects/:projectId/spaces',
          { name: 'Research' },
          { params: { projectId: project.id } },
        )
      ).status(201);
      (
        await owner.post(
          '/v1/projects/:projectId/spaces',
          { name: 'Open Desk' },
          { params: { projectId: project.id } },
        )
      ).status(201);
    });

    // Seeded, not created: the local profile cannot provision a real session
    // (SPACE-3's note). Both rows are their caller's OWN, so the sharing gate
    // the move takes (`can_manage_sharing`) is satisfied by ownership.
    const ownerSession = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: ownerId,
      visibility: 'private',
    });
    const memberSession = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: memberId,
      visibility: 'private',
    });

    await ctx.step('PATCH {space:"research"} files a project-level session → 200', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/sessions/:sessionId',
        { space: 'research' },
        { params: { projectId: project.id, sessionId: ownerSession } },
      );
      r.status(200).body().has('$.space', 'research');
      const list = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { space: 'research' },
      });
      list.status(200);
      if (!list.json<any[]>().some((s: any) => s.session_id === ownerSession)) {
        throw new Error(`the moved session is not in ?space=research: ${list.text()}`);
      }
    });

    await ctx.step('PATCH {space:"open-desk"} moves it between spaces → 200', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/sessions/:sessionId',
        { space: 'open-desk' },
        { params: { projectId: project.id, sessionId: ownerSession } },
      );
      r.status(200).body().has('$.space', 'open-desk');
    });

    await ctx.step('PATCH {space:null} moves it back to the project level → 200', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/sessions/:sessionId',
        { space: null },
        { params: { projectId: project.id, sessionId: ownerSession } },
      );
      r.status(200).body().has('$.space', null);
      const list = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { space: '' },
      });
      list.status(200);
      if (!list.json<any[]>().some((s: any) => s.session_id === ownerSession)) {
        throw new Error(`the session did not come back to the project level: ${list.text()}`);
      }
    });

    await ctx.step('an undeclared space → 400 SPACE_NOT_DECLARED', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/sessions/:sessionId',
        { space: 'nope' },
        { params: { projectId: project.id, sessionId: ownerSession } },
      );
      r.status(400).body().has('$.code', 'SPACE_NOT_DECLARED');
    });

    await ctx.step(
      'a member with no grant cannot move their OWN session into a space → 403',
      async () => {
        const r = await asMember.patch(
          '/v1/projects/:projectId/sessions/:sessionId',
          { space: 'research' },
          { params: { projectId: project.id, sessionId: memberSession } },
        );
        r.status(403).body().has('$.code', 'space_not_accessible');
      },
    );

    await ctx.step('after the grant, the same move succeeds → 200', async () => {
      const grant = await owner.post(
        '/v1/projects/:projectId/resource-grants',
        {
          resource_type: 'space',
          resource_id: 'research',
          principal_type: 'member',
          principal_id: memberId,
        },
        { params: { projectId: project.id } },
      );
      grant.status(201);
      const r = await asMember.patch(
        '/v1/projects/:projectId/sessions/:sessionId',
        { space: 'research' },
        { params: { projectId: project.id, sessionId: memberSession } },
      );
      r.status(200).body().has('$.space', 'research');
    });
  },
);
