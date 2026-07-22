/**
 * Project triggers — manage-gated CRUD. Maps to spec §17 (TRG-1..5).
 * Trigger create commits the project manifest (a real git commit).
 */
import { flow } from '../core/flow';

flow(
  'TRG-1',
  { domain: 'triggers', routes: ['GET /v1/projects/:projectId/triggers'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('list triggers', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/triggers', { params: { projectId: p.id } });
      r.status(200);
    });
    // project.trigger.read gate (IAM enforcement audit) — a stranger with no
    // project access at all still 404s (loadProjectForUser denies before the
    // leaf assert is reached); the leaf itself is proven at the unit/integration
    // level (unit-iam-v2-role-perms + integration-project-read-leaf-gates-http),
    // since the built-in floor role always carries project.trigger.read and this
    // suite has no custom-role fixture to withhold just that leaf.
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/triggers', { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/triggers', { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

flow(
  'TRG-2',
  { domain: 'triggers', routes: ['POST /v1/projects/:projectId/triggers'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('create a cron trigger with a pinned model → 201', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Nightly',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'do nightly work',
          model: 'anthropic/claude-sonnet-4-6',
        },
        { params: { projectId: p.id } },
      );
      r.status(201).body().has('triggers[0].model', 'anthropic/claude-sonnet-4-6');
    });
    await ctx.step('duplicate slug → 409', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/triggers',
          {
            name: 'Nightly',
            type: 'cron',
            cron: '0 0 3 * * *',
            timezone: 'UTC',
            prompt_template: 'again',
          },
          { params: { projectId: p.id } },
        );
      r.status(409);
    });
  },
);

flow(
  'TRG-3',
  { domain: 'triggers', routes: ['PATCH /v1/projects/:projectId/triggers/:slug'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.client
      .as(ctx.P.OWNER)
      .post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Toggle Me',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
        },
        { params: { projectId: p.id } },
      );
    await ctx.step('disable trigger → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/triggers/:slug',
          { enabled: false },
          { params: { projectId: p.id, slug: 'toggle-me' } },
        );
      r.status(200);
    });
    // Regression: a PATCH body with ONLY `model` must still persist — it was
    // previously dropped silently (manifest-key allowlist omitted "model").
    await ctx.step('patch model only → persists', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/triggers/:slug',
          { model: 'openai/gpt-5' },
          { params: { projectId: p.id, slug: 'toggle-me' } },
        );
      r.status(200).body().has('triggers[0].model', 'openai/gpt-5');
    });
  },
);

flow(
  'TRG-4',
  { domain: 'triggers', routes: ['DELETE /v1/projects/:projectId/triggers/:slug'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.client
      .as(ctx.P.OWNER)
      .post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Delete Me',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
        },
        { params: { projectId: p.id } },
      );
    await ctx.step('delete trigger → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/projects/:projectId/triggers/:slug', {
          params: { projectId: p.id, slug: 'delete-me' },
        });
      r.status(200);
    });
  },
);

// TRG-10 — GET /triggers is leaf-gated on project.trigger.read (IAM enforcement
// audit). The built-in floor role always carries trigger.read, so the only way
// to withhold JUST that leaf is a custom (Enterprise) role. A member bound to a
// custom project role granting project.read but NOT project.trigger.read can
// still load the project (read passes) yet is rejected 403 at GET /triggers —
// the leaf assert firing exactly where the audit wanted it. A second member on
// the built-in floor role (which includes trigger.read) still gets 200, proving
// the gate isn't a blanket denial.
flow(
  'TRG-10',
  {
    domain: 'triggers',
    routes: [
      'GET /v1/projects/:projectId/triggers',
      'PUT /v1/accounts/:accountId/iam/enterprise-demo',
      'POST /v1/accounts/:accountId/iam/roles',
      'POST /v1/accounts/:accountId/iam/policies',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const noTriggerRead = await team.addMember('member');
    const floorMember = await team.addMember('member');
    const roleKey = `notrig_${team.id.replace(/-/g, '').slice(0, 10)}`;
    let roleId = '';

    await ctx.step(
      'enable enterprise-demo (entitles this account for custom-role writes)',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .put(
            '/v1/accounts/:accountId/iam/enterprise-demo',
            { enabled: true },
            { params: { accountId: team.id } },
          );
        r.status(200).body().has('$.enabled', true);
      },
    );

    await ctx.step(
      'create a custom project role with project.read but NOT project.trigger.read',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post(
            '/v1/accounts/:accountId/iam/roles',
            {
              key: roleKey,
              name: 'No trigger read',
              resourceType: 'project',
              actions: ['project.read'],
            },
            { params: { accountId: team.id } },
          );
        r.status(201);
        roleId = r.json<any>().role_id;
      },
    );

    await ctx.step('bind that member to the custom role on this project', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/iam/policies',
        {
          principalType: 'member',
          principalId: noTriggerRead.userId!,
          roleId,
          scopeType: 'project',
          scopeId: project.id,
        },
        { params: { accountId: team.id } },
      );
      r.status(201);
    });

    await ctx.step('member WITHOUT trigger.read → GET /triggers 403 (leaf gate)', async () => {
      const r = await ctx.client
        .as(noTriggerRead)
        .get('/v1/projects/:projectId/triggers', { params: { projectId: project.id } });
      r.status(403);
    });

    await ctx.step('floor member WITH trigger.read → GET /triggers 200', async () => {
      await team.grantProjectRole(project.id, floorMember.userId!, 'user');
      const r = await ctx.client
        .as(floorMember)
        .get('/v1/projects/:projectId/triggers', { params: { projectId: project.id } });
      r.status(200);
    });
  },
);

// ── TRG-11: triggers CRUD authz boundaries ─────────────────────────────────
// TRG-1 covers the NONMEMBER (not in account) + ANON boundary on GET only.
// This sweep proves the missing boundaries on the mutating routes:
//   - ANON → 401 on POST/PATCH/DELETE/fire/activation (auth boundary)
//   - a project `member` (floor role 'user' → 'member') holds trigger.read +
//     trigger.fire but NOT project.write (the 'manage' floor) NOR
//     trigger.create/update/delete. So:
//       GET /triggers → 200 (read passes)
//       POST /triggers → 403 (manage floor fails)
//       PATCH /:slug → 403 (manage floor fails)
//       DELETE /:slug → 403 (manage floor fails)
//       PATCH /activation → 403 (manage floor fails)
//       POST /:slug/fire → 202/404 (read floor + trigger.fire leaf — but unknown
//         slug → 404, not 403; the leaf fires AFTER the project loads)
//   Distinct from TRG-1's NONMEMBER (membership 403/404): here the user IS a
//   project member with an explicit role; the 403 is the role-permission leaf.
flow(
  'TRG-11',
  {
    domain: 'triggers',
    routes: [
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'DELETE /v1/projects/:projectId/triggers/:slug',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
      'PATCH /v1/projects/:projectId/triggers/activation',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'user');
    const asMember = ctx.client.as(member);

    // Seed one trigger so PATCH/DELETE/fire have a real slug to target (the
    // 403 fires at the manage FLOOR, before the slug is even looked up, so a
    // missing slug would still 403 — but using a real slug proves the denial
    // is the authz gate, not a 404 masquerading as a denial).
    await ctx.client.as(ctx.P.OWNER).post(
      '/v1/projects/:projectId/triggers',
      {
        name: 'Target Trigger',
        type: 'cron',
        cron: '0 0 3 * * *',
        timezone: 'UTC',
        prompt_template: 'noop',
      },
      { params: { projectId: project.id } },
    );

    // ── ANON → 401 on every mutating route ──────────────────────────────
    await ctx.step('ANON POST → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/projects/:projectId/triggers',
          { name: 'x', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' },
          { params: { projectId: project.id } },
        );
      r.status(401);
    });
    await ctx.step('ANON PATCH → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          '/v1/projects/:projectId/triggers/:slug',
          { enabled: false },
          { params: { projectId: project.id, slug: 'target-trigger' } },
        );
      r.status(401);
    });
    await ctx.step('ANON DELETE → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).del('/v1/projects/:projectId/triggers/:slug', {
        params: { projectId: project.id, slug: 'target-trigger' },
      });
      r.status(401);
    });
    await ctx.step('ANON fire → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post(
        '/v1/projects/:projectId/triggers/:slug/fire',
        {},
        {
          params: { projectId: project.id, slug: 'target-trigger' },
        },
      );
      r.status(401);
    });
    await ctx.step('ANON activation → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          '/v1/projects/:projectId/triggers/activation',
          { paused: true },
          { params: { projectId: project.id } },
        );
      r.status(401);
    });

    // ── project member (floor) authz boundary ───────────────────────────
    await ctx.step('member GET /triggers → 200 (holds trigger.read)', async () => {
      const r = await asMember.get('/v1/projects/:projectId/triggers', {
        params: { projectId: project.id },
      });
      r.status(200);
    });
    await ctx.step('member POST → 403 (no project.write / trigger.create)', async () => {
      const r = await asMember.post(
        '/v1/projects/:projectId/triggers',
        { name: 'nope', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' },
        { params: { projectId: project.id } },
      );
      r.status(403);
    });
    await ctx.step('member PATCH → 403 (no trigger.update)', async () => {
      const r = await asMember.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { enabled: false },
        { params: { projectId: project.id, slug: 'target-trigger' } },
      );
      r.status(403);
    });
    await ctx.step('member DELETE → 403 (no trigger.delete)', async () => {
      const r = await asMember.del('/v1/projects/:projectId/triggers/:slug', {
        params: { projectId: project.id, slug: 'target-trigger' },
      });
      r.status(403);
    });
    await ctx.step('member activation → 403 (no trigger.update)', async () => {
      const r = await asMember.patch(
        '/v1/projects/:projectId/triggers/activation',
        { paused: true },
        { params: { projectId: project.id } },
      );
      r.status(403);
    });
    // fire is the ONE route a floor member CAN reach: read floor + trigger.fire
    // leaf (both in the member baseline). Unknown slug → 404 (slug lookup is
    // after the project loads); a real slug would actually fire a session
    // (funded), so target an unknown slug to stay unfunded and still prove the
    // member is NOT 403'd at the gate.
    await ctx.step('member fire unknown slug → 404 (NOT 403 — holds trigger.fire)', async () => {
      const r = await asMember.post(
        '/v1/projects/:projectId/triggers/:slug/fire',
        {},
        {
          params: { projectId: project.id, slug: 'no-such-trigger' },
        },
      );
      r.status(404);
    });
  },
);

// ── TRG-12: POST trigger input validation ───────────────────────────────────
// parseTriggerDraft (lib/triggers.ts) gates every field. TRG-2 only proves the
// happy path + duplicate-slug 409. This sweep encodes each validation branch:
//   - missing name → 400
//   - missing type → 400
//   - bad type (not cron/webhook) → 400
//   - missing prompt_template → 400
//   - invalid session_mode → 400
//   - pinned session_mode without session_id → 400
//   - pinned with a session_id that doesn't belong to this project → 400
//   - webhook without secret_env → 400
//   - webhook with bad secret_env (not ^[A-Z_][A-Z0-9_]*$) → 400
//   - cron without cron expr AND without run_at → 400
//   - cron with bad run_at (not ISO) → 400
//   - invalid slug (explicit, doesn't match ^[a-z0-9][a-z0-9_-]{0,127}$) → 400
flow(
  'TRG-12',
  { domain: 'triggers', routes: ['POST /v1/projects/:projectId/triggers'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };

    await ctx.step('missing name → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('missing type → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('bad type (not cron/webhook) → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'event', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('missing prompt_template → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('invalid session_mode → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'x',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
          session_mode: 'bogus',
        },
        { params },
      );
      r.status(400);
    });
    await ctx.step('pinned session_mode without session_id → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'x',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
          session_mode: 'pinned',
        },
        { params },
      );
      r.status(400);
    });
    await ctx.step('pinned with session_id from another project → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'x',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
          session_mode: 'pinned',
          session_id: '00000000-0000-0000-0000-000000000000',
        },
        { params },
      );
      r.status(400);
    });
    await ctx.step('webhook without secret_env → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'webhook', prompt_template: 'x' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('webhook with bad secret_env (lowercase) → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'webhook', prompt_template: 'x', secret_env: 'lowercase_name' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('webhook with bad secret_env (starts with digit) → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'webhook', prompt_template: 'x', secret_env: '9BAD' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('cron without cron expr AND without run_at → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'cron', timezone: 'UTC', prompt_template: 'x' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('cron with bad run_at (not ISO) → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'cron', timezone: 'UTC', prompt_template: 'x', run_at: 'not-a-date' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('explicit invalid slug (uppercase) → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'x',
          slug: 'UPPERCASE',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
        },
        { params },
      );
      r.status(400);
    });
    await ctx.step('explicit invalid slug (starts with dash) → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'x',
          slug: '-leading-dash',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
        },
        { params },
      );
      r.status(400);
    });
  },
);

// ── TRG-13: PATCH/DELETE/activation edge cases ─────────────────────────────
// TRG-3/4 prove the happy path. This sweep encodes the remaining boundaries:
//   - PATCH unknown slug → 404
//   - PATCH no-op body (no manifest keys, e.g. { }) → 200, no git commit
//   - DELETE unknown slug → 404
//   - DELETE invalid slug format → 400 (regex gate, before manifest lookup)
//   - activation happy path: pause → resume round-trip, persisted on readback
//   - activation non-boolean paused → 400
//   - activation unknown project → 404
flow(
  'TRG-13',
  {
    domain: 'triggers',
    routes: [
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'DELETE /v1/projects/:projectId/triggers/:slug',
      'PATCH /v1/projects/:projectId/triggers/activation',
      'GET /v1/projects/:projectId/triggers',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };

    // Seed a trigger to target.
    await owner.post(
      '/v1/projects/:projectId/triggers',
      {
        name: 'Edge Target',
        type: 'cron',
        cron: '0 0 3 * * *',
        timezone: 'UTC',
        prompt_template: 'x',
      },
      { params },
    );

    await ctx.step('PATCH unknown slug → 404', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { enabled: false },
        { params: { ...params, slug: 'no-such-trigger' } },
      );
      r.status(404);
    });
    await ctx.step('PATCH no-op body {} → 200 (no manifest keys, no commit)', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        {},
        { params: { ...params, slug: 'edge-target' } },
      );
      r.status(200);
    });
    await ctx.step('DELETE unknown slug → 404', async () => {
      const r = await owner.del('/v1/projects/:projectId/triggers/:slug', {
        params: { ...params, slug: 'no-such-trigger' },
      });
      r.status(404);
    });
    await ctx.step('DELETE invalid slug format (uppercase) → 400', async () => {
      const r = await owner.del('/v1/projects/:projectId/triggers/:slug', {
        params: { ...params, slug: 'UPPERCASE' },
      });
      r.status(400);
    });
    await ctx.step('DELETE invalid slug format (leading dash) → 400', async () => {
      const r = await owner.del('/v1/projects/:projectId/triggers/:slug', {
        params: { ...params, slug: '-leading-dash' },
      });
      r.status(400);
    });

    // ── activation kill-switch round-trip ───────────────────────────────
    await ctx.step('activation pause → 200, triggers_paused reflected on readback', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/activation',
        { paused: true },
        { params },
      );
      r.status(200);
      const readback = await owner.get('/v1/projects/:projectId/triggers', { params });
      readback.status(200);
      if (readback.json<any>().triggers_paused !== true) {
        throw new Error('triggers_paused not persisted as true after pause');
      }
    });
    await ctx.step('activation resume → 200, triggers_paused false on readback', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/activation',
        { paused: false },
        { params },
      );
      r.status(200);
      const readback = await owner.get('/v1/projects/:projectId/triggers', { params });
      readback.status(200);
      if (readback.json<any>().triggers_paused !== false) {
        throw new Error('triggers_paused not persisted as false after resume');
      }
    });
    await ctx.step('activation non-boolean paused → 400', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/activation',
        { paused: 'yes' },
        { params },
      );
      r.status(400);
    });
    await ctx.step('activation missing paused → 400', async () => {
      const r = await owner.patch('/v1/projects/:projectId/triggers/activation', {}, { params });
      r.status(400);
    });
  },
);
