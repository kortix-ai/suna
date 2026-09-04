/**
 * Subprojects — named containers inside a project. Maps to spec §12b
 * (SUBP-1..5). The manifest (`kortix.yaml` → `subprojects.<slug>`) is the
 * source of truth for identity/instructions/context/agent/sessions-mode; the
 * database holds only the session join (`project_sessions.subproject`) and
 * the IAM grants (generic `resource-grants`, `resource_type: 'subproject'`).
 *
 * Every CRUD write commits the manifest, exactly like triggers next door
 * (triggers.flow.ts) — projects here use `managedGit: true` so the commit is
 * real and readable back through `GET /projects/:id/commits`.
 *
 * The local profile cannot provision a real session (`503
 * KORTIX_URL_UNREACHABLE` — see marketplace.flow.ts MKTP-11's precedent), so
 * `POST /sessions {subproject}` is asserted at the subproject
 * validation/authorization boundary only: SUBP-2 proves the 400
 * `SUBPROJECT_NOT_DECLARED` and 403 `subproject_not_accessible` gates fire
 * (and stop firing once granted), never that a session actually starts.
 */
import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';
import { CliSandbox, throwIfCliInfraFailure, type CliResult } from '../fixtures/cli';

// ─── SUBP-1 — CRUD + manifest commit ────────────────────────────────────────

flow(
  'SUBP-1',
  {
    domain: 'subprojects',
    routes: [
      'GET /v1/projects/:projectId/subprojects',
      'POST /v1/projects/:projectId/subprojects',
      'GET /v1/projects/:projectId/subprojects/:slug',
      'PATCH /v1/projects/:projectId/subprojects/:slug',
      'DELETE /v1/projects/:projectId/subprojects/:slug',
      'POST /v1/projects/:projectId/subprojects/:slug/context',
      'DELETE /v1/projects/:projectId/subprojects/:slug/context',
      'GET /v1/projects/:projectId/commits',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('OWNER creates "Marketing" → 201, slug derived, defaults', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/subprojects',
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
        .has('$.can_manage', true);
      const body = r.json<any>();
      if (!Array.isArray(body.context) || body.context.length !== 0) {
        throw new Error(`expected context: [] on create, got ${JSON.stringify(body.context)}`);
      }
    });

    await ctx.step('the create committed kortix.yaml (readable via GET /commits)', async () => {
      const r = await owner.get('/v1/projects/:projectId/commits', { params: { projectId: p.id } });
      r.status(200);
      const body = r.json<any>();
      const subjects = (body.commits ?? []).map((c: any) => c.subject as string);
      if (!subjects.some((s: string) => s.includes('feat(subprojects): add marketing'))) {
        throw new Error(`expected a "feat(subprojects): add marketing" commit, got: ${JSON.stringify(subjects)}`);
      }
    });

    await ctx.step('GET list includes it', async () => {
      const r = await owner.get('/v1/projects/:projectId/subprojects', { params: { projectId: p.id } });
      r.status(200);
      const body = r.json<any>();
      if (!body.subprojects.some((s: any) => s.slug === 'marketing')) {
        throw new Error(`list omitted marketing: ${r.text()}`);
      }
    });

    await ctx.step('GET one returns it', async () => {
      const r = await owner.get('/v1/projects/:projectId/subprojects/:slug', {
        params: { projectId: p.id, slug: 'marketing' },
      });
      r.status(200).body().has('$.slug', 'marketing');
    });

    await ctx.step('PATCH instructions + sessions:shared → 200, persisted', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/subprojects/:slug',
        { instructions: 'Always write in British English.', sessions: 'shared' },
        { params: { projectId: p.id, slug: 'marketing' } },
      );
      r.status(200)
        .body()
        .has('$.instructions', 'Always write in British English.')
        .has('$.sessions', 'shared');
    });

    await ctx.step('PATCH {} → 200, no manifest commit', async () => {
      const before = (
        await owner.get('/v1/projects/:projectId/commits', { params: { projectId: p.id } })
      ).json<any>();
      const r = await owner.patch(
        '/v1/projects/:projectId/subprojects/:slug',
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

    await ctx.step('duplicate slug → 409 SUBPROJECT_SLUG_TAKEN', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/subprojects',
        { name: 'Marketing' },
        { params: { projectId: p.id } },
      );
      r.status(409).body().has('$.code', 'SUBPROJECT_SLUG_TAKEN');
    });

    await ctx.step('unknown agent → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/subprojects',
        { name: 'Ghost Agent', agent: 'no-such-agent' },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('invalid slug → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/subprojects',
        { name: 'Bad Slug', slug: 'Not A Slug!' },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('bad sessions mode → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/subprojects',
        { name: 'Bad Sessions', sessions: 'public' },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('context add → 200, basename-derived repo path appears in context', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/subprojects/:slug/context',
        { path: 'notes/brief.md', content: 'Brand brief.' },
        { params: { projectId: p.id, slug: 'marketing' } },
      );
      r.status(200);
      const body = r.json<any>();
      if (!body.context.includes('.kortix/subprojects/marketing/brief.md')) {
        throw new Error(`context add did not add the expected path: ${JSON.stringify(body.context)}`);
      }
    });

    await ctx.step('context rm removes the entry (repo file untouched)', async () => {
      const r = await owner.del('/v1/projects/:projectId/subprojects/:slug/context', {
        params: { projectId: p.id, slug: 'marketing' },
        query: { path: '.kortix/subprojects/marketing/brief.md' },
      });
      r.status(200);
      const body = r.json<any>();
      if (body.context.includes('.kortix/subprojects/marketing/brief.md')) {
        throw new Error(`context rm left the entry behind: ${JSON.stringify(body.context)}`);
      }
    });

    await ctx.step('context rm on an unlisted path → 404', async () => {
      const r = await owner.del('/v1/projects/:projectId/subprojects/:slug/context', {
        params: { projectId: p.id, slug: 'marketing' },
        query: { path: 'never/listed.md' },
      });
      r.status(404);
    });

    await ctx.step('DELETE → 200, then GET → 404', async () => {
      const del = await owner.del('/v1/projects/:projectId/subprojects/:slug', {
        params: { projectId: p.id, slug: 'marketing' },
      });
      del.status(200).body().has('$.ok', true);
      const get = await owner.get('/v1/projects/:projectId/subprojects/:slug', {
        params: { projectId: p.id, slug: 'marketing' },
      });
      get.status(404);
    });
  },
);

// ─── SUBP-2 — authz: closed by default, granted via resource-grants ────────

flow(
  'SUBP-2',
  {
    domain: 'subprojects',
    routes: [
      'GET /v1/projects/:projectId/subprojects',
      'POST /v1/projects/:projectId/subprojects',
      'GET /v1/projects/:projectId/subprojects/:slug',
      'PATCH /v1/projects/:projectId/subprojects/:slug',
      'DELETE /v1/projects/:projectId/subprojects/:slug',
      'POST /v1/projects/:projectId/sessions',
      'POST /v1/projects/:projectId/resource-grants',
      'GET /v1/projects/:projectId/resource-grants',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const member = await team.addMember('member');
    if (!member.userId) throw new Error('SUBP-2 member fixture has no user id');
    await team.grantProjectRole(project.id, member.userId, 'member');
    const asMember = ctx.client.as(member);

    await ctx.step('OWNER declares the "marketing" subproject', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/subprojects',
        { name: 'Marketing' },
        { params: { projectId: project.id } },
      );
      r.status(201);
    });

    await ctx.step('member with NO grant → list is empty (closed by default)', async () => {
      const r = await asMember.get('/v1/projects/:projectId/subprojects', {
        params: { projectId: project.id },
      });
      r.status(200).body().has('$.subprojects', []);
    });

    await ctx.step('member with NO grant → GET one → 404 (undeclared and inaccessible are the same answer)', async () => {
      const r = await asMember.get('/v1/projects/:projectId/subprojects/:slug', {
        params: { projectId: project.id, slug: 'marketing' },
      });
      r.status(404);
    });

    await ctx.step('member with NO grant → session create with this subproject → 403 subproject_not_accessible', async () => {
      const r = await asMember.post(
        '/v1/projects/:projectId/sessions',
        { subproject: 'marketing', initial_prompt: 'noop' },
        { params: { projectId: project.id } },
      );
      r.status(403)
        .body()
        .has('$.code', 'subproject_not_accessible')
        .has('$.accessible_subprojects', []);
    });

    let grantId = '';
    await ctx.step('OWNER grants the subproject to the member → 201', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/resource-grants',
        {
          resource_type: 'subproject',
          resource_id: 'marketing',
          principal_type: 'member',
          principal_id: member.userId,
        },
        { params: { projectId: project.id } },
      );
      r.status(201)
        .body()
        .has('$.resource_type', 'subproject')
        .has('$.resource_id', 'marketing');
      grantId = r.json<any>().grant_id;
    });

    await ctx.step('member now lists + reads it', async () => {
      const list = await asMember.get('/v1/projects/:projectId/subprojects', {
        params: { projectId: project.id },
      });
      list.status(200);
      if (!list.json<any>().subprojects.some((s: any) => s.slug === 'marketing')) {
        throw new Error(`list still omits marketing after the grant: ${list.text()}`);
      }
      const get = await asMember.get('/v1/projects/:projectId/subprojects/:slug', {
        params: { projectId: project.id, slug: 'marketing' },
      });
      get.status(200);
    });

    await ctx.step(
      'member now clears the SUBPROJECT gate on session create (never the 403 subproject_not_accessible)',
      async () => {
        const r = await asMember.post(
          '/v1/projects/:projectId/sessions',
          { subproject: 'marketing', initial_prompt: 'noop' },
          { params: { projectId: project.id } },
        );
        if (r.statusCode === 403 && r.json<any>()?.code === 'subproject_not_accessible') {
          throw new Error(`still denied by the subproject gate after a grant: ${r.text()}`);
        }
        // Whatever boundary the local profile hits NEXT (no real sandbox
        // provider configured) is not this flow's contract — documented, not
        // asserted, per MKTP-11's precedent.
      },
    );

    await ctx.step('GET /resource-grants shows the subproject resource + the grant', async () => {
      const r = await owner.get('/v1/projects/:projectId/resource-grants', {
        params: { projectId: project.id },
      });
      r.status(200);
      const body = r.json<any>();
      if (!body.resources.subprojects.some((s: any) => s.id === 'marketing')) {
        throw new Error(`resources.subprojects omits marketing: ${JSON.stringify(body.resources)}`);
      }
      if (
        !body.grants.some(
          (g: any) => g.grant_id === grantId && g.resource_type === 'subproject' && g.resource_id === 'marketing',
        )
      ) {
        throw new Error(`grants list omits the subproject grant: ${JSON.stringify(body.grants)}`);
      }
    });

    await ctx.step('member PATCH → 403 (no project.customize.write)', async () => {
      const r = await asMember.patch(
        '/v1/projects/:projectId/subprojects/:slug',
        { description: 'nope' },
        { params: { projectId: project.id, slug: 'marketing' } },
      );
      r.status(403);
    });

    await ctx.step('member DELETE → 403', async () => {
      const r = await asMember.del('/v1/projects/:projectId/subprojects/:slug', {
        params: { projectId: project.id, slug: 'marketing' },
      });
      r.status(403);
    });

    await ctx.step('session create naming an UNDECLARED subproject → 400 SUBPROJECT_NOT_DECLARED', async () => {
      const r = await asMember.post(
        '/v1/projects/:projectId/sessions',
        { subproject: 'nope', initial_prompt: 'noop' },
        { params: { projectId: project.id } },
      );
      r.status(400).body().has('$.code', 'SUBPROJECT_NOT_DECLARED');
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/subprojects', { params: { projectId: project.id } });
      r.status(401);
    });
  },
);

// ─── SUBP-3 — sessions filter/hiding + sessions:shared visibility ──────────

flow(
  'SUBP-3',
  {
    domain: 'subprojects',
    routes: [
      'POST /v1/projects/:projectId/subprojects',
      'POST /v1/projects/:projectId/resource-grants',
      'GET /v1/projects/:projectId/sessions',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const member1 = await team.addMember('member');
    const member2 = await team.addMember('member');
    if (!member1.userId || !member2.userId) throw new Error('SUBP-3 members have no user id');
    await team.grantProjectRole(project.id, member1.userId, 'member');
    await team.grantProjectRole(project.id, member2.userId, 'member');
    const asMember1 = ctx.client.as(member1);

    await ctx.step('OWNER declares a private subproject "research" and a shared one "open-desk"', async () => {
      const priv = await owner.post(
        '/v1/projects/:projectId/subprojects',
        { name: 'Research' },
        { params: { projectId: project.id } },
      );
      priv.status(201).body().has('$.sessions', 'private');
      const shared = await owner.post(
        '/v1/projects/:projectId/subprojects',
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
      subproject: 'research',
    });
    // member2's session in the SHARED subproject — private visibility, but
    // `sessions: shared` opens it to everyone granted the subproject.
    await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: member2.userId,
      visibility: 'private',
      subproject: 'open-desk',
    });

    await ctx.step('member1 WITHOUT a grant on "research" cannot see even their OWN row in it', async () => {
      const r = await asMember1.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { subproject: 'research' },
      });
      r.status(200).body().has('$', []);
    });

    await ctx.step('OWNER grants member1 "research"', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/resource-grants',
        {
          resource_type: 'subproject',
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
        query: { subproject: 'research' },
      });
      r.status(200);
      if (r.json<any>().length !== 1) {
        throw new Error(`expected exactly 1 session after the grant, got: ${r.text()}`);
      }
    });

    await ctx.step('member1 WITHOUT a grant on "open-desk" cannot see member2\'s row', async () => {
      const r = await asMember1.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { subproject: 'open-desk' },
      });
      r.status(200).body().has('$', []);
    });

    await ctx.step('OWNER grants member1 "open-desk"', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/resource-grants',
        {
          resource_type: 'subproject',
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
        query: { subproject: 'open-desk' },
      });
      r.status(200);
      if (r.json<any>().length !== 1) {
        throw new Error(`expected member2's row via sessions:shared, got: ${r.text()}`);
      }
    });

    await ctx.step('?subproject=<slug> and ?subproject= (none) are both accepted → 200 arrays', async () => {
      const withSlug = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { subproject: 'research' },
      });
      withSlug.status(200);
      if (!Array.isArray(withSlug.json())) throw new Error('?subproject=<slug> did not return an array');

      const none = await owner.get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { subproject: '' },
      });
      none.status(200);
      if (!Array.isArray(none.json())) throw new Error('?subproject= did not return an array');
    });
  },
);

// ─── SUBP-4 — triggers carry a subproject back-reference ───────────────────

flow(
  'SUBP-4',
  {
    domain: 'subprojects',
    routes: [
      'POST /v1/projects/:projectId/subprojects',
      'DELETE /v1/projects/:projectId/subprojects/:slug',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('OWNER declares the "ops" subproject', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/subprojects',
        { name: 'Ops' },
        { params: { projectId: p.id } },
      );
      r.status(201);
    });

    await ctx.step('POST trigger with subproject → 201, GET shows it', async () => {
      const created = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Ops Trigger',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
          subproject: 'ops',
        },
        { params: { projectId: p.id } },
      );
      created.status(201).body().has('triggers[0].subproject', 'ops');
    });

    await ctx.step('POST trigger with an UNDECLARED subproject → 400 SUBPROJECT_NOT_DECLARED', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Bad Trigger',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
          subproject: 'no-such-subproject',
        },
        { params: { projectId: p.id } },
      );
      r.status(400).body().has('$.code', 'SUBPROJECT_NOT_DECLARED');
    });

    await ctx.step('PATCH an unrelated field ({enabled:false}) keeps subproject', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { enabled: false },
        { params: { projectId: p.id, slug: 'ops-trigger' } },
      );
      r.status(200).body().has('triggers[0].subproject', 'ops');
    });

    await ctx.step('PATCH {subproject:null} clears it', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { subproject: null },
        { params: { projectId: p.id, slug: 'ops-trigger' } },
      );
      r.status(200).body().has('triggers[0].subproject', null);
    });

    await ctx.step('re-attach the subproject, then delete it — the trigger loses the back-reference', async () => {
      const patched = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { subproject: 'ops' },
        { params: { projectId: p.id, slug: 'ops-trigger' } },
      );
      patched.status(200).body().has('triggers[0].subproject', 'ops');

      const deleted = await owner.del('/v1/projects/:projectId/subprojects/:slug', {
        params: { projectId: p.id, slug: 'ops' },
      });
      deleted.status(200);

      const list = await owner.get('/v1/projects/:projectId/triggers', { params: { projectId: p.id } });
      list.status(200).body().has('triggers[0].subproject', null);
    });
  },
);

// ─── SUBP-5 — CLI as real processes ─────────────────────────────────────────

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
  'SUBP-5',
  {
    domain: 'subprojects',
    routes: [
      'GET /v1/accounts/me',
      'GET /v1/projects/:projectId/subprojects',
      'POST /v1/projects/:projectId/subprojects',
      'GET /v1/projects/:projectId/subprojects/:slug',
      'PATCH /v1/projects/:projectId/subprojects/:slug',
      'DELETE /v1/projects/:projectId/subprojects/:slug',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ managedGit: true });
    const sandbox = await authenticatedCli(ctx, 'subprojects');
    try {
      await ctx.step('kortix subprojects create "Marketing" --json → 201, slug derived', async () => {
        const created = parseJson<{ slug: string; name: string }>(
          await sandbox.run([
            'subprojects',
            'create',
            'Marketing',
            '--description',
            'd',
            '--project',
            project.id,
            '--json',
          ]),
          'kortix subprojects create',
        );
        if (created.slug !== 'marketing') throw new Error(`expected slug "marketing", got ${created.slug}`);
      });

      await ctx.step('kortix subprojects ls --json contains it', async () => {
        const list = parseJson<{ subprojects: Array<{ slug: string }> }>(
          await sandbox.run(['subprojects', 'ls', '--project', project.id, '--json']),
          'kortix subprojects ls',
        );
        if (!list.subprojects.some((s) => s.slug === 'marketing')) {
          throw new Error(`ls omitted marketing: ${JSON.stringify(list)}`);
        }
      });

      await ctx.step('kortix subprojects show marketing --json', async () => {
        const shown = parseJson<{ slug: string }>(
          await sandbox.run(['subprojects', 'show', 'marketing', '--project', project.id, '--json']),
          'kortix subprojects show',
        );
        if (shown.slug !== 'marketing') throw new Error(`show returned ${shown.slug}`);
      });

      await ctx.step('kortix subprojects update marketing --sessions shared --json', async () => {
        const updated = parseJson<{ sessions: string }>(
          await sandbox.run([
            'subprojects',
            'update',
            'marketing',
            '--sessions',
            'shared',
            '--project',
            project.id,
            '--json',
          ]),
          'kortix subprojects update',
        );
        if (updated.sessions !== 'shared') throw new Error(`update did not persist sessions:shared`);
      });

      await ctx.step('kortix subprojects rm marketing --yes → 0, then show fails', async () => {
        requireExit(
          await sandbox.run(['subprojects', 'rm', 'marketing', '--project', project.id, '--yes']),
          0,
          'kortix subprojects rm',
        );
        const shown = await sandbox.run(['subprojects', 'show', 'marketing', '--project', project.id, '--json']);
        requireExit(shown, 1, 'kortix subprojects show after rm');
      });
    } finally {
      sandbox.dispose();
    }
  },
);
