/**
 * Project triggers — manage-gated CRUD. Maps to spec §17 (TRG-1..5).
 * Trigger create commits the project manifest (a real git commit).
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TriggerListSchema } from '@kortix/api-contract';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import { CliSandbox, throwIfCliInfraFailure } from '../fixtures/cli';
import { createDatabaseSession } from '../fixtures/database-project';
import { enableEnterpriseDemo } from '../fixtures/enterprise-demo';
import { withDb } from '../fixtures/chat';

type TriggerRow = { slug: string; model: string | null };

/**
 * A managed-repo project is seeded from the starter by default (4da295e50b),
 * and the starter ships a `harness-reflector` cron with no model. So the
 * trigger a flow just wrote is NOT `triggers[0]`; find it by slug.
 */
function triggerBySlug(
  body: { triggers: TriggerRow[] },
  slug: string,
): TriggerRow {
  const row = body.triggers.find((trigger) => trigger.slug === slug);
  if (!row) {
    throw new Error(
      `trigger "${slug}" missing from response; got ${JSON.stringify(body.triggers.map((t) => t.slug))}`,
    );
  }
  return row;
}

function expectTriggerModel(body: { triggers: TriggerRow[] }, slug: string, model: string): void {
  const row = triggerBySlug(body, slug);
  if (row.model !== model) {
    throw new Error(`triggers["${slug}"].model === ${JSON.stringify(model)} — got ${JSON.stringify(row.model)}`);
  }
}

type ManifestCommit = { hash: string; message?: string };

/**
 * `kortix.yaml` history on a deployed target lags its writes: the starter seed
 * and the trigger commit land through the managed-git mirror seconds after the
 * API answered. Read until two consecutive reads agree, so a comparison
 * against a later read counts only commits made in between.
 */
async function settledManifestHistory(
  read: () => Promise<ManifestCommit[]>,
): Promise<ManifestCommit[]> {
  let previous: string | null = null;
  const commits = await waitFor(read, {
    until: (value) => {
      const key = JSON.stringify(value.map((commit) => commit.hash));
      const settled = previous === key;
      previous = key;
      return settled;
    },
    timeoutMs: 90_000,
    intervalMs: 3_000,
    description: 'kortix.yaml history settles',
  });
  return commits;
}

flow(
  'TRG-1',
  { domain: 'triggers', routes: ['GET /v1/projects/:projectId/triggers'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step('list triggers; the body is the contract TriggerList envelope', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/triggers', { params: { projectId: p.id } });
      r.status(200).body().schema(TriggerListSchema);
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
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/files/content',
      'GET /v1/projects/:projectId/files/history',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
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
      r.status(201);
      expectTriggerModel(r.json<{ triggers: TriggerRow[] }>(), 'nightly', 'anthropic/claude-sonnet-4-6');
    });
    await ctx.step('the create is a kortix.yaml commit "chore: add trigger nightly" that carries the entry', async () => {
      const owner = ctx.client.as(ctx.P.OWNER);
      await waitFor(
        async () => {
          const r = await owner.get('/v1/projects/:projectId/files/history', { params: { projectId: p.id }, query: { path: 'kortix.yaml' } });
          r.status(200);
          return r.json<{ commits: Array<{ subject: string }> }>().commits;
        },
        {
          until: (commits) => commits.some((c) => c.subject === 'chore: add trigger nightly'),
          timeoutMs: 60_000,
          intervalMs: 2_000,
          description: 'trigger create commit in kortix.yaml history',
        },
      );
      const text = await waitFor(
        async () => {
          const r = await owner.get('/v1/projects/:projectId/files/content', { params: { projectId: p.id }, query: { path: 'kortix.yaml' } });
          r.status(200);
          return r.json<{ content: string }>().content;
        },
        { until: (t) => t.includes('slug: nightly'), timeoutMs: 60_000, intervalMs: 2_000, description: 'kortix.yaml carries the trigger' },
      );
      for (const needle of ['type: cron', 'model: anthropic/claude-sonnet-4-6', 'do nightly work']) {
        if (!text.includes(needle)) throw new Error(`kortix.yaml lacks "${needle}":\n${text}`);
      }
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
    const p = await ctx.fixtures.project({ managedGit: true });
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
    await ctx.step('disable trigger → 200; the rest of the spec is kept', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/triggers/:slug',
          { enabled: false },
          { params: { projectId: p.id, slug: 'toggle-me' } },
        );
      r.status(200);
      const row = r
        .json<{ triggers: Array<{ slug: string; name: string; enabled: boolean; cron: string | null; prompt_template: string }> }>()
        .triggers.find((t) => t.slug === 'toggle-me');
      if (!row || row.enabled !== false || row.name !== 'Toggle Me' || row.cron !== '0 0 3 * * *' || row.prompt_template !== 'x') {
        throw new Error(`PATCH {enabled:false} did not keep the rest of the spec: ${JSON.stringify(row)}`);
      }
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
      r.status(200);
      expectTriggerModel(r.json<{ triggers: TriggerRow[] }>(), 'toggle-me', 'openai/gpt-5');
    });
  },
);

flow(
  'TRG-4',
  { domain: 'triggers', routes: ['DELETE /v1/projects/:projectId/triggers/:slug', 'GET /v1/projects/:projectId/triggers'] },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    for (const name of ['Delete Me', 'Keep Me']) {
      (await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/triggers',
          { name, type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' },
          { params: { projectId: p.id } },
        )).status(201);
    }
    await ctx.step('delete trigger → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/projects/:projectId/triggers/:slug', {
          params: { projectId: p.id, slug: 'delete-me' },
        });
      r.status(200);
    });
    await ctx.step('the delete removes only that entry: GET lists keep-me, not delete-me', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/triggers', { params: { projectId: p.id } });
      r.status(200);
      const slugs = r.json<{ triggers: TriggerRow[] }>().triggers.map((t) => t.slug);
      if (slugs.includes('delete-me') || !slugs.includes('keep-me')) throw new Error(`unexpected triggers after delete: ${JSON.stringify(slugs)}`);
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
      'platform admin enables enterprise-demo (entitles this account for custom-role writes)',
      async () => {
        await enableEnterpriseDemo(ctx, team.id);
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
    // Every payload below is invalid and cannot create a trigger. Retry only
    // gateway-generated outage responses, not API responses with x-request-id.
    const owner = ctx.client.as(ctx.P.OWNER).withTransientGatewayRetries();
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
    await ctx.step('bad type (not cron/webhook/monitor/event) → 400', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'bogus', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' },
        { params },
      );
      r.status(400);
    });
    // KRTX-1721: the first of 6 fields is seconds, so this fires every 30 s.
    await ctx.step('a cron that fires more than once a minute → 400 naming the 60-second minimum', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'x', type: 'cron', cron: '*/30 * * * * *', timezone: 'UTC', prompt_template: 'x' },
        { params },
      );
      r.status(400);
      const error = String(r.json<{ error?: string }>()?.error ?? '');
      if (!error.includes('60 seconds')) throw new Error(`error does not name the minimum: ${error}`);
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
    const p = await ctx.fixtures.project({ managedGit: true });
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
flow(
  'TRG-14',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'GET /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/files/history',
      'GET /v1/projects/:projectId/sessions',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'POST /v1/accounts/:accountId/iam/groups',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const project = await team.project({ managedGit: true });
    const manager = await team.addMember('member');
    if (!manager.userId) throw new Error('trigger access manager fixture has no user id');
    await team.grantProjectRole(project.id, manager.userId, 'manager');
    const teammate = await team.addMember('member');
    const teammateUserId = teammate.userId;
    if (!teammateUserId) throw new Error('trigger access teammate fixture has no user id');
    await team.grantProjectRole(project.id, teammateUserId, 'user');
    const owner = ctx.client.as(ctx.P.OWNER);
    const groupResponse = await owner.post(
      '/v1/accounts/:accountId/iam/groups',
      { name: ctx.fixtures.name('trigger-access-group') },
      { params: { accountId: team.id } },
    );
    groupResponse.status(201);
    const groupId = groupResponse.json<{ group_id: string }>().group_id;
    let manifestCommitHashes: string[] = [];
    const triggerPrivateSessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: crypto.randomUUID(),
      visibility: 'private',
      metadata: {
        source: 'trigger:scheduler',
        trigger_kind: 'git',
        trigger_slug: 'access-policy-target',
      },
    });
    const humanPrivateSessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: crypto.randomUUID(),
      visibility: 'private',
      metadata: {},
    });

    await ctx.step('omitted session_access defaults to private', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Access policy target',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
        },
        { params: { projectId: project.id } },
      );
      r.status(201);
      const access = r.json<{
        triggers: Array<{
          session_access: { mode: string; memberIds: string[]; groupIds: string[] };
        }>;
      }>().triggers[0]?.session_access;
      if (
        JSON.stringify(access) !== JSON.stringify({ mode: 'private', memberIds: [], groupIds: [] })
      ) {
        throw new Error(`unexpected default session_access: ${JSON.stringify(access)}`);
      }
      const readHistory = async (): Promise<ManifestCommit[]> => {
        const history = await owner.get('/v1/projects/:projectId/files/history', {
          params: { projectId: project.id },
          query: { path: 'kortix.yaml' },
        });
        history.status(200);
        return history.json<{ commits: ManifestCommit[] }>().commits;
      };
      manifestCommitHashes = (await settledManifestHistory(readHistory)).map((commit) => commit.hash);
    });

    await ctx.step(
      'project manager opens a private trigger session but not a private human session',
      async () => {
        const triggerSession = await ctx.client.as(manager).get(
          '/v1/projects/:projectId/sessions/:sessionId',
          { params: { projectId: project.id, sessionId: triggerPrivateSessionId } },
        );
        triggerSession.status(200).body().has('$.session_id', triggerPrivateSessionId);

        const humanSession = await ctx.client.as(manager).get(
          '/v1/projects/:projectId/sessions/:sessionId',
          { params: { projectId: project.id, sessionId: humanPrivateSessionId } },
        );
        humanSession.status(404);
      },
    );

    await ctx.step('ordinary project member cannot open a private trigger session', async () => {
      const r = await ctx.client.as(teammate).get(
        '/v1/projects/:projectId/sessions/:sessionId',
        { params: { projectId: project.id, sessionId: triggerPrivateSessionId } },
      );
      r.status(404);
    });

    await ctx.step('ordinary project member cannot discover a private trigger session', async () => {
      const r = await ctx.client.as(teammate).get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
      });
      r.status(200);
      const sessions = r.json<Array<{ session_id: string }>>();
      if (sessions.some((session) => session.session_id === triggerPrivateSessionId)) {
        throw new Error('ordinary member discovered a private trigger session');
      }
    });

    await ctx.step('manager inventory includes the trigger session and hides inaccessible sessions', async () => {
      const r = await ctx.client.as(manager).get('/v1/projects/:projectId/sessions', {
        params: { projectId: project.id },
        query: { scope: 'project' },
      });
      r.status(200);
      const sessions = r.json<Array<{ session_id: string; can_access: boolean }>>();
      const byId = new Map(sessions.map((session) => [session.session_id, session.can_access]));
      if (byId.get(triggerPrivateSessionId) !== true) {
        throw new Error('manager inventory did not grant trigger-session content access');
      }
      if (byId.has(humanPrivateSessionId)) {
        throw new Error('manager inventory exposed an inaccessible private session');
      }
    });

    await ctx.step(
      'policy-only PATCH persists selected access without committing kortix.yaml',
      async () => {
        const r = await owner.patch(
          '/v1/projects/:projectId/triggers/:slug',
          {
            session_access: {
              mode: 'members',
              memberIds: [teammateUserId, teammateUserId],
              groupIds: [groupId, groupId],
            },
          },
          { params: { projectId: project.id, slug: 'access-policy-target' } },
        );
        r.status(200);
        const access = r.json<{
          triggers: Array<{
            session_access: { mode: string; memberIds: string[]; groupIds: string[] };
          }>;
        }>().triggers[0]?.session_access;
        if (
          access?.mode !== 'members' ||
          JSON.stringify(access.memberIds) !== JSON.stringify([teammateUserId]) ||
          JSON.stringify(access.groupIds) !== JSON.stringify([groupId])
        ) {
          throw new Error(`selected session_access was not normalized: ${JSON.stringify(access)}`);
        }
        const current = await settledManifestHistory(async () => {
          const history = await owner.get('/v1/projects/:projectId/files/history', {
            params: { projectId: project.id },
            query: { path: 'kortix.yaml' },
          });
          history.status(200);
          return history.json<{ commits: ManifestCommit[] }>().commits;
        });
        const added = current.filter((commit) => !manifestCommitHashes.includes(commit.hash));
        if (added.length > 0 || current.length !== manifestCommitHashes.length) {
          throw new Error(
            `policy-only PATCH created a kortix.yaml commit: ${JSON.stringify(
              added.map((commit) => `${commit.hash.slice(0, 8)} ${commit.message ?? ''}`),
            )}`,
          );
        }
      },
    );

    await ctx.step('explicit project access persists', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { session_access: { mode: 'project', memberIds: [], groupIds: [] } },
        { params: { projectId: project.id, slug: 'access-policy-target' } },
      );
      r.status(200).body().has('triggers[0].session_access.mode', 'project');
    });

    await ctx.step('empty selected access normalizes to private', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { session_access: { mode: 'members', memberIds: [], groupIds: [] } },
        { params: { projectId: project.id, slug: 'access-policy-target' } },
      );
      r.status(200).body().has('triggers[0].session_access.mode', 'private');
    });

    await ctx.step('unknown member is rejected', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        {
          session_access: {
            mode: 'members',
            memberIds: ['00000000-0000-4000-8000-000000000001'],
            groupIds: [],
          },
        },
        { params: { projectId: project.id, slug: 'access-policy-target' } },
      );
      r.status(400);
    });

    await ctx.step('cross-account member is rejected', async () => {
      if (!ctx.P.NONMEMBER.userId) throw new Error('NONMEMBER fixture has no user id');
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        {
          session_access: {
            mode: 'members',
            memberIds: [ctx.P.NONMEMBER.userId],
            groupIds: [],
          },
        },
        { params: { projectId: project.id, slug: 'access-policy-target' } },
      );
      r.status(400);
    });

    await ctx.step('unknown group is rejected', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        {
          session_access: {
            mode: 'members',
            memberIds: [],
            groupIds: ['00000000-0000-4000-8000-000000000002'],
          },
        },
        { params: { projectId: project.id, slug: 'access-policy-target' } },
      );
      r.status(400);
    });
  },
);

flow(
  'TRG-15',
  {
    domain: 'triggers',
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'DELETE /v1/projects/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const project = await team.project({ managedGit: false });
    const manager = await team.addMember('member');
    if (!manager.userId) throw new Error('cleanup manager fixture has no user id');
    await team.grantProjectRole(project.id, manager.userId, 'manager');
    const teammate = await team.addMember('member');
    if (!teammate.userId) throw new Error('cleanup teammate fixture has no user id');
    await team.grantProjectRole(project.id, teammate.userId, 'user');

    const triggerSession = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: crypto.randomUUID(),
      visibility: 'private',
      metadata: {
        source: 'trigger:scheduler',
        trigger_kind: 'git',
        trigger_slug: 'hourly-heartbeat',
      },
    });
    const siblingTriggerSession = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: crypto.randomUUID(),
      visibility: 'private',
      metadata: {
        source: 'trigger:scheduler',
        trigger_kind: 'git',
        trigger_slug: 'hourly-heartbeat',
      },
    });
    const automationSession = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: crypto.randomUUID(),
      visibility: 'project',
      metadata: { source: 'agent:harness' },
    });

    await ctx.step('manager reads a private trigger session before pruning it', async () => {
      const r = await ctx.client.as(manager).get('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId: project.id, sessionId: triggerSession },
      });
      r.status(200).body().has('$.session_id', triggerSession);
    });

    await ctx.step('manager deletes a private trigger session', async () => {
      const r = await ctx.client.as(manager).del('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId: project.id, sessionId: triggerSession },
      });
      r.status(200);
    });

    await ctx.step('ordinary member cannot discover the sibling trigger session to delete it', async () => {
      const r = await ctx.client.as(teammate).del('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId: project.id, sessionId: siblingTriggerSession },
      });
      r.status(404);
    });

    await ctx.step('non-manager delete of a project-visible automation session is refused', async () => {
      const r = await ctx.client.as(teammate).del('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId: project.id, sessionId: automationSession },
      });
      r.status(403)
        .body()
        .has('$.error', 'Only the session owner or a project manager can stop this session');
    });

    await ctx.step('manager deletes the project-visible automation session', async () => {
      const r = await ctx.client.as(manager).del('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId: project.id, sessionId: automationSession },
      });
      r.status(200);
    });
  },
);

// ─────────────── TRG-16 — kortix.yaml `imports:` end to end ────────────────────

const IMPORTED_WEEKLY = `# weekly report — declared in an imported file
triggers:
  - slug: weekly-report
    name: Weekly report
    type: cron
    enabled: true
    cron: "0 0 15 * * 0"
    timezone: UTC
    prompt: |-
      Build the weekly report.

      STEP 1 - check sent items.
`;

const IMPORTED_DOCKETS = `triggers:
  - slug: docket-monitor
    name: Docket monitor
    type: cron
    enabled: false
    cron: "0 0 9 * * 1-5"
    timezone: UTC
    prompt: check the docket
`;

type ImportedTriggerRow = { slug: string; path: string; enabled: boolean };

flow(
  'TRG-16',
  {
    domain: 'triggers',
    // The split manifest reaches the project the way a user's does: a real
    // `kortix ship` push through the git proxy. No API route writes a file.
    requires: ['managedGitPush'],
    timeoutMs: 600_000,
    routes: [
      'GET /v1/accounts/me',
      'POST /v1/projects/provision',
      'POST /v1/projects/:projectId/git-token',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/files/content',
    ],
  },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-trg16') });
    const sb = new CliSandbox('trg16');
    ctx.track('cli-sandbox', sb.cwd);
    const owner = ctx.client.as(ctx.P.OWNER);
    let projectId = '';
    let rootText = '';

    const readFile = async (path: string): Promise<string> => {
      const r = await owner.get('/v1/projects/:projectId/files/content', {
        params: { projectId },
        query: { path },
      });
      r.status(200);
      return r.json<{ content: string }>().content;
    };
    const listTriggers = async (): Promise<{ triggers: ImportedTriggerRow[]; errors: unknown[] }> => {
      const r = await owner.get('/v1/projects/:projectId/triggers', { params: { projectId } });
      r.status(200);
      return r.json<{ triggers: ImportedTriggerRow[]; errors: unknown[] }>();
    };

    try {
      const init = await sb.run(['init', 'imports-fixture', '-y']);
      if (init.exitCode !== 0) throw new Error(`init failed: ${init.all}`);
      sb.enter('imports-fixture');
      const login = await sb.login(pat, { noProject: true, account: ctx.P.accountId });
      if (login.exitCode !== 0) throw new Error(`login failed: ${login.all}`);

      await ctx.step(
        'split the manifest: root declares `imports: [.kortix/triggers/]`, two nested files declare the triggers → `kortix validate` exit 0',
        async () => {
          rootText = `${sb.readFile('kortix.yaml').trimEnd()}\nimports:\n  - .kortix/triggers/\n`;
          sb.writeFile('kortix.yaml', rootText);
          sb.writeFile('.kortix/triggers/reports/weekly.yaml', IMPORTED_WEEKLY);
          sb.writeFile('.kortix/triggers/dockets.yaml', IMPORTED_DOCKETS);
          const r = await sb.run(['validate', '--json']);
          throwIfCliInfraFailure(r, 'validate');
          if (r.exitCode !== 0) throw new Error(`validate rejected the split manifest: ${r.all}`);
        },
      );

      await ctx.step(
        'a slug declared in two files → `kortix validate` exit 1 naming both files; removing the clash restores exit 0',
        async () => {
          sb.writeFile(
            '.kortix/triggers/clash.yaml',
            IMPORTED_DOCKETS.replace('docket-monitor', 'weekly-report'),
          );
          const bad = await sb.run(['validate', '--json']);
          if (bad.exitCode !== 1) throw new Error(`expected exit 1, got ${bad.exitCode}: ${bad.all}`);
          if (
            !bad.stdout.includes('.kortix/triggers/clash.yaml') ||
            !bad.stdout.includes('.kortix/triggers/reports/weekly.yaml')
          ) {
            throw new Error(`duplicate-slug error does not name both files: ${bad.stdout}`);
          }
          sb.writeFile('.kortix/triggers/clash.yaml', 'triggers: []\n');
          const good = await sb.run(['validate', '--json']);
          if (good.exitCode !== 0) throw new Error(`validate still failing: ${good.all}`);
        },
      );

      await ctx.step('`kortix ship` pushes the split manifest → exit 0, project linked', async () => {
        const r = await sb.run(['ship', '-y', '-m', 'ke2e: split manifest'], { timeoutMs: 120_000 });
        throwIfCliInfraFailure(r, 'ship');
        if (r.exitCode !== 0) throw new Error(`ship failed: ${r.all}`);
        const link = JSON.parse(sb.readFile('.kortix/link.json')) as { project_id?: string };
        if (!link.project_id) throw new Error('ship wrote no project_id');
        projectId = link.project_id;
        ctx.track('project', projectId);
      });

      await ctx.step(
        'GET /triggers lists the imported triggers with no errors, each `path` naming its declaring file',
        async () => {
          const listed = await waitFor(listTriggers, {
            until: (v) => v.triggers.some((t) => t.slug === 'weekly-report'),
            timeoutMs: 60_000,
            intervalMs: 2_000,
            description: 'imported triggers visible through the API',
          });
          if (listed.errors.length > 0) {
            throw new Error(`trigger parse errors: ${JSON.stringify(listed.errors)}`);
          }
          const paths = Object.fromEntries(listed.triggers.map((t) => [t.slug, t.path]));
          if (
            paths['weekly-report'] !== '.kortix/triggers/reports/weekly.yaml#triggers.weekly-report' ||
            paths['docket-monitor'] !== '.kortix/triggers/dockets.yaml#triggers.docket-monitor'
          ) {
            throw new Error(`imported triggers report the wrong declaring file: ${JSON.stringify(paths)}`);
          }
        },
      );

      await ctx.step(
        'PATCH an imported trigger {enabled:false} → 200; only its declaring file changes, kortix.yaml is byte-identical',
        async () => {
          const r = await owner.patch(
            '/v1/projects/:projectId/triggers/:slug',
            { enabled: false },
            { params: { projectId, slug: 'weekly-report' } },
          );
          r.status(200);
          const weekly = await waitFor(() => readFile('.kortix/triggers/reports/weekly.yaml'), {
            until: (text) => /enabled: false/.test(text),
            timeoutMs: 60_000,
            intervalMs: 2_000,
            description: 'the imported file carries the edit',
          });
          if (!weekly.includes('STEP 1 - check sent items.')) {
            throw new Error(`the edit damaged the imported prompt: ${weekly}`);
          }
          const root = await readFile('kortix.yaml');
          if (root !== rootText) throw new Error(`kortix.yaml was rewritten:\n${root}`);
          if (root.includes('weekly-report')) {
            throw new Error('the imported trigger was flattened into kortix.yaml');
          }
          if ((await readFile('.kortix/triggers/dockets.yaml')) !== IMPORTED_DOCKETS) {
            throw new Error('a sibling imported file was rewritten');
          }
        },
      );

      await ctx.step(
        'POST a new trigger → 201, written to kortix.yaml; POST a slug an imported file declares → 409; list stays free of duplicates',
        async () => {
          const body = {
            name: 'Brand new',
            slug: 'brand-new',
            type: 'cron',
            cron: '0 0 3 * * *',
            timezone: 'UTC',
            prompt_template: 'new',
          };
          (await owner.post('/v1/projects/:projectId/triggers', body, { params: { projectId } })).status(201);
          (
            await owner.post(
              '/v1/projects/:projectId/triggers',
              { ...body, name: 'Dup', slug: 'docket-monitor' },
              { params: { projectId } },
            )
          ).status(409);
          const root = await waitFor(() => readFile('kortix.yaml'), {
            until: (text) => text.includes('brand-new'),
            timeoutMs: 60_000,
            intervalMs: 2_000,
            description: 'the new trigger lands in the root manifest',
          });
          if (!root.includes('.kortix/triggers/')) throw new Error('the root lost its imports');
          const listed = await listTriggers();
          const slugs = listed.triggers.map((t) => t.slug);
          if (listed.errors.length > 0 || new Set(slugs).size !== slugs.length) {
            throw new Error(`duplicates or errors after the write: ${JSON.stringify(listed)}`);
          }
          for (const slug of ['weekly-report', 'docket-monitor', 'brand-new']) {
            if (!slugs.includes(slug)) throw new Error(`missing ${slug}: ${JSON.stringify(slugs)}`);
          }
        },
      );
    } finally {
      sb.dispose();
    }
  },
);

// TRG-17 — a trigger's listing says when it runs next, and a manual fire that
// fails is recorded on the trigger like a failed cron fire (KRTX-1743). Before,
// a failed manual or webhook fire answered 500 and left `last_status` as it
// was, and no surface showed the next run.
flow(
  'TRG-17',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return; // the local stack runs no sandbox, so a fire fails after authorization
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const digest = async () =>
      (await owner.get('/v1/projects/:projectId/triggers', { params }))
        .status(200)
        .json<{ triggers: Array<{ slug: string; next_fire_at?: string | null; last_status?: string | null; last_error?: string | null }> }>()
        .triggers.find((t) => t.slug === 'digest');

    await ctx.step('a daily cron trigger lists its next run, within a day of now', async () => {
      (
        await owner.post(
          '/v1/projects/:projectId/triggers',
          { name: 'Digest', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'Summarize.' },
          { params },
        )
      ).status(201);
      const next = Date.parse(String((await digest())?.next_fire_at ?? ''));
      const now = Date.now();
      if (!(next > now - 60_000 && next < now + 25 * 60 * 60 * 1000)) {
        throw new Error(`next_fire_at is ${String((await digest())?.next_fire_at)}`);
      }
    });

    await ctx.step('a manual fire that fails is recorded on the trigger: last_status failed, with the error', async () => {
      const fired = await owner.post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: { ...params, slug: 'digest' } });
      fired.status(500);
      const error = fired.json<{ error?: string }>()?.error ?? '';
      const after = await digest();
      if (after?.last_status !== 'failed') throw new Error(`last_status is ${String(after?.last_status)}`);
      if (!after.last_error || !error.startsWith(after.last_error.slice(0, 40))) {
        throw new Error(`last_error "${String(after?.last_error)}" is not the fire's error "${error}"`);
      }
    });
  },
);

// ── TRG-18: backpressure queues a fire durably (contract TRG-5 / TRG-7) ──
// A deployed lifecycle worker would boot the queued create into a real
// session. The local profile runs none (KORTIX_WORKERS_ENABLED=false,
// core/local-stack.ts), so the queued command stays queued and is inspectable.
flow(
  'TRG-18',
  {
    domain: 'triggers',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
      'POST /v1/webhooks/projects/:projectId/:slug',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return;
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const secret = `ke2e-hook-${crypto.randomUUID()}`;
    (await owner.post(
      '/v1/projects/:projectId/triggers',
      {
        name: 'Backpressure cron',
        slug: 'bp-cron',
        type: 'cron',
        cron: '0 0 3 * * *',
        timezone: 'UTC',
        prompt_template: 'Run at {{ fired_at }}',
        model: 'anthropic/claude-sonnet-4-6',
      },
      { params },
    )).status(201);
    (await owner.post('/v1/projects/:projectId/secrets', { name: 'BP_HOOK_SECRET', value: secret, strategy: 'broker', consumer: 'connector' }, { params })).status(200);
    (await owner.post(
      '/v1/projects/:projectId/triggers',
      { name: 'Backpressure hook', slug: 'bp-hook', type: 'webhook', secret_env: 'BP_HOOK_SECRET', prompt_template: 'New {{ body.action }}' },
      { params },
    )).status(201);
    // `queued` (the column default) is a provisioning status; the per-project
    // limit is KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT, default 3.
    for (let i = 0; i < 3; i += 1) {
      await createDatabaseSession(ctx.env, { projectId: p.id, accountId: p.accountId!, userId: ctx.P.OWNER.userId! });
    }
    try {
      await ctx.step(
        'manual fire under backpressure → 202 queued; one queued create_session with the rendered prompt, the pinned model and private visibility; last_fired_at stamped',
        async () => {
          const r = await owner.post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: { ...params, slug: 'bp-cron' } });
          r.status(202).body().has('$.status', 'queued').has('$.reason', 'project provisioning backpressure').has('$.deduped', false);
          const commandId = r.json<{ command_id: string | null }>().command_id;
          if (!commandId) throw new Error(`queued fire returned no command_id: ${r.text()}`);
          const row = await withDb(ctx, async (db) =>
            (await db.query('SELECT status, command_type, source, payload FROM kortix.session_lifecycle_commands WHERE command_id = $1', [commandId])).rows[0],
          );
          const body = row?.payload?.body ?? {};
          // The 202 above proves it queued; the lifecycle worker may claim it
          // (`running`) before this read, so either status is the same command.
          if (
            !['queued', 'running'].includes(row?.status) ||
            row.command_type !== 'create_session' ||
            row.source !== 'trigger:manual' ||
            row.payload?.visibility !== 'private' ||
            body.opencode_model !== 'anthropic/claude-sonnet-4-6' ||
            body.metadata?.trigger_slug !== 'bp-cron' ||
            typeof body.initial_prompt !== 'string' ||
            !body.initial_prompt.startsWith('Run at 20') ||
            body.initial_prompt.includes('{{')
          ) {
            throw new Error(`queued create command is wrong: ${JSON.stringify(row)}`);
          }
          const listed = await owner.get('/v1/projects/:projectId/triggers', { params });
          listed.status(200);
          const fired = listed.json<{ triggers: Array<{ slug: string; last_fired_at: string | null }> }>().triggers.find((t) => t.slug === 'bp-cron');
          if (!fired?.last_fired_at) throw new Error(`last_fired_at not stamped: ${JSON.stringify(fired)}`);
        },
      );

      await ctx.step(
        'signed webhook under backpressure → 202 queued; the same X-Kortix-Delivery-Id again → status deduped, the same command; one command row',
        async () => {
          const rawBody = JSON.stringify({ action: 'opened' });
          const deliveryId = `ke2e-${crypto.randomUUID()}`;
          const deliver = () =>
            ctx.client.as(ctx.P.ANON).post('/v1/webhooks/projects/:projectId/:slug', rawBody, {
              params: { projectId: p.id, slug: 'bp-hook' },
              raw: true,
              headers: {
                'content-type': 'application/json',
                'x-kortix-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
                'x-kortix-delivery-id': deliveryId,
              },
            });
          const first = await deliver();
          first.status(202).body().has('$.status', 'queued').has('$.reason', 'project provisioning backpressure').has('$.deduped', false);
          const commandId = first.json<{ command_id: string | null }>().command_id;
          if (!commandId) throw new Error(`queued webhook returned no command_id: ${first.text()}`);
          (await deliver()).status(202).body().has('$.status', 'deduped').has('$.command_id', commandId).has('$.deduped', true);
          const n = await withDb(ctx, async (db) =>
            (await db.query<{ n: number }>(
              'SELECT count(*)::int AS n FROM kortix.session_lifecycle_commands WHERE idempotency_key = $1',
              [`trigger:webhook:${p.id}:bp-hook:${deliveryId}`],
            )).rows[0]?.n,
          );
          if (n !== 1) throw new Error(`expected one command for the delivery, found ${n}`);
        },
      );
    } finally {
      await withDb(ctx, (db) => db.query('DELETE FROM kortix.session_lifecycle_commands WHERE project_id = $1', [p.id])).catch(() => {});
    }
  },
);

// ── TRG-19: GET /triggers reports manifest parse errors (contract TRG-1) ──
flow(
  'TRG-19',
  {
    domain: 'triggers',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: ['POST /v1/projects/:projectId/triggers', 'GET /v1/projects/:projectId/triggers'],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return; // pushes straight to the local bare repository, as PROJ-39
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    type Listing = { triggers: Array<{ slug: string }>; errors: Array<{ slug: string }> };
    const list = async (): Promise<Listing> => {
      const r = await owner.get('/v1/projects/:projectId/triggers', { params });
      r.status(200);
      return r.json<Listing>();
    };
    const runtimeRows = () =>
      withDb(ctx, async (db) =>
        (await db.query("SELECT slug FROM kortix.project_trigger_runtime WHERE project_id = $1 AND slug = 'keep-me'", [p.id])).rows,
      );
    const repoUrl = await withDb(ctx, async (db) =>
      String((await db.query('SELECT repo_url FROM kortix.projects WHERE project_id = $1', [p.id])).rows[0]?.repo_url ?? ''),
    );
    const work = mkdtempSync(join(tmpdir(), 'ke2e-trg19-'));
    const push = (manifest: string, message: string) => {
      writeFileSync(join(work, 'kortix.yaml'), manifest);
      execFileSync('git', ['add', 'kortix.yaml'], { cwd: work, stdio: 'pipe' });
      execFileSync('git', ['-c', 'user.name=KE2E', '-c', 'user.email=ke2e@kortix.invalid', 'commit', '-qm', message], { cwd: work, stdio: 'pipe' });
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: work, stdio: 'pipe' });
    };
    try {
      await ctx.step('POST a cron trigger → 201 and one runtime row for it', async () => {
        (await owner.post(
          '/v1/projects/:projectId/triggers',
          { name: 'Keep me', slug: 'keep-me', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'keep' },
          { params },
        )).status(201);
        if ((await runtimeRows()).length !== 1) throw new Error('trigger create wrote no runtime row');
      });
      execFileSync('git', ['clone', '-q', '--branch', 'main', repoUrl, '.'], { cwd: work, stdio: 'pipe' });

      await ctx.step('push a manifest with one good and one broken trigger → GET lists the good one and names the broken one in errors', async () => {
        push(
          'kortix_version: 2\nproject:\n  name: trg19\ndefault_agent: kortix\nagents:\n  kortix: {}\ntriggers:\n' +
            '  - slug: keep-me\n    name: Keep me\n    type: cron\n    cron: "0 0 3 * * *"\n    timezone: UTC\n    prompt: keep\n' +
            '  - slug: broken\n    type: cron\n    prompt: no cron field here\n',
          'ke2e: one broken trigger',
        );
        const listed = await waitFor(list, {
          until: (v) => v.errors.some((e) => e.slug === 'broken'),
          timeoutMs: 90_000,
          intervalMs: 2_000,
          description: 'the broken trigger reaches the API mirror',
        });
        const slugs = listed.triggers.map((t) => t.slug);
        if (!slugs.includes('keep-me') || slugs.includes('broken')) throw new Error(`parse error dropped or kept the wrong triggers: ${JSON.stringify(listed)}`);
      });

      await ctx.step('push an unparseable manifest → GET 200 {triggers:[], errors:[(manifest)]}; the runtime row survives', async () => {
        push('kortix_version: [invalid\n', 'ke2e: unparseable manifest');
        const listed = await waitFor(list, {
          until: (v) => v.errors.some((e) => e.slug === '(manifest)'),
          timeoutMs: 90_000,
          intervalMs: 2_000,
          description: 'the unparseable manifest reaches the API mirror',
        });
        if (listed.triggers.length !== 0) throw new Error(`unparseable manifest still lists triggers: ${JSON.stringify(listed)}`);
        if ((await runtimeRows()).length !== 1) throw new Error('an unparseable manifest pruned the trigger runtime row');
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

// ── TRG-20: webhook ingress against a REAL webhook trigger (contract TRG-7) ──
// TRG-7 and SEC-F probe only a bogus project. Here the trigger, its secret and
// the signature are real. Triggers are paused first: the pause check runs AFTER
// authentication (routes/trigger-webhooks.ts), so an authenticated delivery
// answers 200 `skipped` and never creates a session or a sandbox.
flow(
  'TRG-20',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/secrets',
      'DELETE /v1/projects/:projectId/secrets/:name',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'PATCH /v1/projects/:projectId/triggers/activation',
      'POST /v1/webhooks/projects/:projectId/:slug',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const secret = `ke2e-hook-${crypto.randomUUID()}`;
    const rawBody = JSON.stringify({ action: 'opened' });
    const sign = (payload: string, key = secret) => `sha256=${createHmac('sha256', key).update(payload).digest('hex')}`;
    const deliver = (headers: Record<string, string>, slug = 'hook', projectId = p.id) =>
      ctx.client.as(ctx.P.ANON).post('/v1/webhooks/projects/:projectId/:slug', rawBody, {
        params: { projectId, slug },
        raw: true,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const rejected = async (headers: Record<string, string>, slug?: string) => {
      (await deliver(headers, slug)).status(401).body().has('$.error', 'Invalid webhook signature');
    };
    const accepted = async (headers: Record<string, string>) => {
      (await deliver(headers)).status(200).body().has('$.status', 'skipped');
    };
    const webhookTrigger = (slug: string, secretEnv: string) => ({
      name: slug,
      slug,
      type: 'webhook',
      secret_env: secretEnv,
      prompt_template: 'New {{ body.action }}',
    });
    type Listed = { triggers: Array<{ slug: string; name: string; type: string; secret_env: string | null; webhook_url: string | null }> };
    const listed = async (): Promise<Listed['triggers']> => {
      const r = await owner.get('/v1/projects/:projectId/triggers', { params });
      r.status(200);
      return r.json<Listed>().triggers;
    };

    await ctx.step('webhook trigger naming a missing secret → 409 webhook_secret_missing; nothing listed', async () => {
      const r = await owner.post('/v1/projects/:projectId/triggers', webhookTrigger('missing-hook', 'NO_SUCH_HOOK_SECRET'), { params });
      r.status(409).body().has('$.code', 'webhook_secret_missing');
      if ((await listed()).some((t) => t.slug === 'missing-hook')) throw new Error('a refused webhook trigger was committed');
    });

    await ctx.step('webhook trigger naming a sandbox-delivered secret → 409 webhook_secret_delivery_mismatch', async () => {
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'SANDBOX_HOOK_SECRET', value: 'sandbox-only' }, { params })).status([200, 201]);
      const r = await owner.post('/v1/projects/:projectId/triggers', webhookTrigger('sandbox-hook', 'SANDBOX_HOOK_SECRET'), { params });
      r.status(409).body().has('$.code', 'webhook_secret_delivery_mismatch');
    });

    await ctx.step('connector-delivered secret → 201; the listing carries secret_env and the public webhook_url', async () => {
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'HOOK_SECRET', value: secret, strategy: 'broker', consumer: 'connector' }, { params }))
        .status(200).body().has('$.strategy', 'broker').has('$.consumer', 'connector');
      (await owner.post('/v1/projects/:projectId/triggers', webhookTrigger('hook', 'HOOK_SECRET'), { params })).status(201);
      const row = (await listed()).find((t) => t.slug === 'hook');
      if (!row || row.type !== 'webhook' || row.secret_env !== 'HOOK_SECRET' || !row.webhook_url?.endsWith(`/v1/webhooks/projects/${p.id}/hook`)) {
        throw new Error(`webhook trigger listing is wrong: ${JSON.stringify(row)}`);
      }
    });

    await ctx.step('pause triggers server-side → 200, triggers_paused true', async () => {
      (await owner.patch('/v1/projects/:projectId/triggers/activation', { paused: true }, { params })).status(200).body().has('$.triggers_paused', true);
    });

    await ctx.step('malformed project id or slug → 400 before any lookup', async () => {
      (await deliver({}, 'hook', 'not-a-uuid')).status(400).body().has('$.error', 'Invalid project id');
      (await deliver({}, 'Bad_Slug')).status(400).body().has('$.error', 'Invalid trigger slug');
    });

    await ctx.step('no credential header, an unknown slug, a wrong signature → the same 401', async () => {
      await rejected({});
      await rejected({ 'x-kortix-signature': sign(rawBody) }, 'no-such-hook');
      await rejected({ 'x-kortix-signature': sign(rawBody, 'wrong-secret') });
    });

    await ctx.step('a valid X-Kortix-Signature or X-Hub-Signature-256 authenticates → 200 skipped (paused)', async () => {
      await accepted({ 'x-kortix-signature': sign(rawBody) });
      await accepted({ 'x-hub-signature-256': sign(rawBody) });
    });

    await ctx.step('X-Kortix-Timestamp signs <timestamp>.<body>: 1 h stale or 1 h ahead → 401, current → 200', async () => {
      const now = Math.floor(Date.now() / 1000);
      const stamped = (ts: number) => ({ 'x-kortix-timestamp': String(ts), 'x-kortix-signature': sign(`${ts}.${rawBody}`) });
      await rejected(stamped(now - 3600));
      await rejected(stamped(now + 3600));
      await accepted(stamped(now));
    });

    await ctx.step('static token: a wrong X-Kortix-Token → 401; the secret as X-Kortix-Token or Bearer → 200', async () => {
      await rejected({ 'x-kortix-token': 'nope' });
      await accepted({ 'x-kortix-token': secret });
      await accepted({ authorization: `Bearer ${secret}` });
    });

    await ctx.step('the secret loses connector delivery → a signed delivery is 401; PATCH → 409 webhook_secret_delivery_mismatch', async () => {
      (await owner.del('/v1/projects/:projectId/secrets/:name', { params: { ...params, name: 'HOOK_SECRET' } })).status(200);
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'HOOK_SECRET', value: secret }, { params })).status([200, 201]);
      await rejected({ 'x-kortix-signature': sign(rawBody) });
      const r = await owner.patch('/v1/projects/:projectId/triggers/:slug', { name: 'Renamed hook' }, { params: { ...params, slug: 'hook' } });
      r.status(409).body().has('$.code', 'webhook_secret_delivery_mismatch');
      if ((await listed()).find((t) => t.slug === 'hook')?.name !== 'hook') throw new Error('a refused PATCH changed the trigger');
    });
  },
);

type EventTriggerRow = TriggerRow & {
  type: string;
  event: { connector: string; type: string; config: Record<string, unknown>; status: string; error: string | null } | null;
};

flow(
  'TRG-21',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'DELETE /v1/projects/:projectId/triggers/:slug',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const eventOf = (body: { triggers: EventTriggerRow[] }) => {
      const row = body.triggers.find((t) => t.slug === 'new-mail');
      if (!row) throw new Error(`trigger "new-mail" missing; got ${JSON.stringify(body.triggers.map((t) => t.slug))}`);
      return row;
    };
    await ctx.step('create an event trigger → 201, listed as type event with its connector, event and config', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'New mail',
          type: 'event',
          connector: 'inbox',
          event: 'EXAMPLE_NEW_MESSAGE',
          event_config: { label: 'INBOX' },
          prompt_template: 'Triage {{ event.data.subject }}',
        },
        { params },
      );
      r.status(201);
      const row = eventOf(r.json<{ triggers: EventTriggerRow[] }>());
      if (row.type !== 'event') throw new Error(`type === "event" — got ${JSON.stringify(row.type)}`);
      if (row.event?.connector !== 'inbox' || row.event.type !== 'EXAMPLE_NEW_MESSAGE') {
        throw new Error(`event echo wrong: ${JSON.stringify(row.event)}`);
      }
      if (row.event.config.label !== 'INBOX') throw new Error(`config lost: ${JSON.stringify(row.event.config)}`);
      // The connector is not declared in kortix.yaml, so no subscription can exist.
      if (row.event.status !== 'error' || !/inbox/.test(row.event.error ?? '')) {
        throw new Error(`expected status error naming "inbox" — got ${JSON.stringify(row.event)}`);
      }
    });
    await ctx.step('PATCH event_config → 200 and the new config reads back', async () => {
      const r = await owner.patch(
        '/v1/projects/:projectId/triggers/:slug',
        { event_config: { label: 'STARRED' } },
        { params: { ...params, slug: 'new-mail' } },
      );
      r.status(200);
      const config = eventOf(r.json<{ triggers: EventTriggerRow[] }>()).event?.config;
      if (config?.label !== 'STARRED') throw new Error(`config not updated: ${JSON.stringify(config)}`);
    });
    await ctx.step('DELETE → 200 and the trigger leaves the list', async () => {
      (await owner.del('/v1/projects/:projectId/triggers/:slug', { params: { ...params, slug: 'new-mail' } })).status(200);
      const listed = (await owner.get('/v1/projects/:projectId/triggers', { params })).json<{ triggers: EventTriggerRow[] }>();
      if (listed.triggers.some((t) => t.slug === 'new-mail')) throw new Error('trigger still listed after DELETE');
    });
  },
);

flow(
  'TRG-22',
  { domain: 'triggers', routes: ['POST /v1/projects/:projectId/triggers'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER).withTransientGatewayRetries();
    const params = { projectId: p.id };
    const base = { name: 'x', prompt_template: 'x' };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['event without connector', { ...base, type: 'event', event: 'EXAMPLE_EVENT' }],
      ['event without event', { ...base, type: 'event', connector: 'inbox' }],
      ['event with cron', { ...base, type: 'event', connector: 'inbox', event: 'EXAMPLE_EVENT', cron: '0 0 3 * * *' }],
      ['event with non-object event_config', { ...base, type: 'event', connector: 'inbox', event: 'EXAMPLE_EVENT', event_config: 'nope' }],
      ['cron with connector', { ...base, type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', connector: 'inbox' }],
    ];
    for (const [name, body] of cases) {
      await ctx.step(`${name} → 400`, async () => {
        (await owner.post('/v1/projects/:projectId/triggers', body, { params })).status(400);
      });
    }
  },
);

flow(
  'TRG-23',
  { domain: 'triggers', routes: ['POST /v1/webhooks/events/:provider'] },
  async (ctx) => {
    const anon = ctx.client.as(ctx.P.ANON);
    await ctx.step('unknown provider → 404', async () => {
      (await anon.post('/v1/webhooks/events/:provider', { hello: 'world' }, { params: { provider: 'nope' } })).status(404);
    });
    await ctx.step('composio without a valid signature → 401 (secret set) or 503 (no secret)', async () => {
      const r = await anon.post('/v1/webhooks/events/:provider', { hello: 'world' }, { params: { provider: 'composio' } });
      r.status([401, 503]);
    });
  },
);

flow(
  'TRG-24',
  { domain: 'triggers', routes: ['GET /v1/projects/:projectId/triggers/event-types'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const params = { projectId: p.id };
    await ctx.step('ANON → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).get('/v1/projects/:projectId/triggers/event-types', { params, query: { connector: 'inbox' } })).status(401);
    });
    await ctx.step('missing connector → 400', async () => {
      (await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/triggers/event-types', { params })).status(400);
    });
    await ctx.step('unknown connector → 404', async () => {
      (await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/triggers/event-types', { params, query: { connector: 'inbox' } })).status(404);
    });
  },
);

flow(
  'TRG-25',
  { domain: 'triggers', routes: ['GET /v1/projects/:projectId/triggers/event-apps'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const params = { projectId: p.id };
    await ctx.step('ANON → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).get('/v1/projects/:projectId/triggers/event-apps', { params })).status(401);
    });
    await ctx.step('owner → 200 with an apps array (empty when no event provider is configured)', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/triggers/event-apps', { params });
      r.status(200);
      if (!Array.isArray(r.json<{ apps: unknown[] }>().apps)) throw new Error('apps must be an array');
    });
  },
);

flow(
  'TRG-26',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    type AccountRow = { slug: string; event: { connector: string; account: string | null; connected_as: string | null } | null };
    const eventOf = (body: { triggers: AccountRow[] }) => {
      const row = body.triggers.find((t) => t.slug === 'acct-mail');
      if (!row?.event) throw new Error(`trigger "acct-mail" missing; got ${JSON.stringify(body.triggers.map((t) => t.slug))}`);
      return row.event;
    };
    const create = (extra: Record<string, unknown>) =>
      owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'Acct mail', type: 'event', connector: 'inbox', event: 'EXAMPLE_NEW_MESSAGE', prompt_template: 'x', ...extra },
        { params },
      );
    await ctx.step('create with event_account → 201 and the listing echoes account, with no account feeding it', async () => {
      const r = await create({ event_account: 'acme-bot' });
      r.status(201);
      const event = eventOf(r.json<{ triggers: AccountRow[] }>());
      if (event.account !== 'acme-bot' || event.connected_as !== null) {
        throw new Error(`expected account "acme-bot" and connected_as null — got ${JSON.stringify(event)}`);
      }
    });
    await ctx.step('PATCH event_account: null → 200 and the account clears to the connector default', async () => {
      const r = await owner.patch('/v1/projects/:projectId/triggers/:slug', { event_account: null }, { params: { ...params, slug: 'acct-mail' } });
      r.status(200);
      const event = eventOf(r.json<{ triggers: AccountRow[] }>());
      if (event.account !== null) throw new Error(`account not cleared: ${JSON.stringify(event)}`);
    });
    await ctx.step('PATCH event_account → 200 and it reads back; PATCH of another field keeps it', async () => {
      const slug = 'acct-mail';
      (await owner.patch('/v1/projects/:projectId/triggers/:slug', { event_account: 'ops-bot' }, { params: { ...params, slug } })).status(200);
      const r = await owner.patch('/v1/projects/:projectId/triggers/:slug', { name: 'Acct mail 2' }, { params: { ...params, slug } });
      r.status(200);
      const event = eventOf(r.json<{ triggers: AccountRow[] }>());
      if (event.account !== 'ops-bot') throw new Error(`account lost on unrelated PATCH: ${JSON.stringify(event)}`);
    });
    await ctx.step('empty event_account → 400; event_account on a cron trigger → 400', async () => {
      (await create({ name: 'Bad', event_account: ' ' })).status(400);
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'Cron', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x', event_account: 'acme-bot' },
        { params },
      );
      r.status(400);
    });
  },
);

flow(
  'TRG-27',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    type SourceRow = { slug: string; event: { source?: string | null } | null };
    const sourceOf = (body: { triggers: SourceRow[] }) => {
      const row = body.triggers.find((t) => t.slug === 'src-mail');
      if (!row?.event) throw new Error(`trigger "src-mail" missing; got ${JSON.stringify(body.triggers.map((t) => t.slug))}`);
      return row.event.source ?? null;
    };
    const create = (extra: Record<string, unknown>) =>
      owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'Src mail', type: 'event', connector: 'inbox', event: 'EXAMPLE_NEW_MESSAGE', prompt_template: 'x', ...extra },
        { params },
      );
    await ctx.step('create with event_source composio → 201 and the listing echoes event.source', async () => {
      const r = await create({ event_source: 'composio' });
      r.status(201);
      const source = sourceOf(r.json<{ triggers: SourceRow[] }>());
      if (source !== 'composio') throw new Error(`expected source "composio" — got ${JSON.stringify(source)}`);
    });
    await ctx.step('PATCH of another field keeps the source; PATCH event_source null clears it', async () => {
      const at = { params: { ...params, slug: 'src-mail' } };
      const kept = await owner.patch('/v1/projects/:projectId/triggers/:slug', { name: 'Src mail 2' }, at);
      kept.status(200);
      if (sourceOf(kept.json<{ triggers: SourceRow[] }>()) !== 'composio') throw new Error('source lost on an unrelated PATCH');
      const cleared = await owner.patch('/v1/projects/:projectId/triggers/:slug', { event_source: null }, at);
      cleared.status(200);
      const source = sourceOf(cleared.json<{ triggers: SourceRow[] }>());
      // The connector is undeclared, so no provider fills in: the source is unset.
      if (source !== null) throw new Error(`source not cleared: ${JSON.stringify(source)}`);
    });
    await ctx.step('unknown event_source → 400 naming the sources; blank → 400; event_source on a cron trigger → 400', async () => {
      const unknown = await create({ name: 'Bad source', event_source: 'nope' });
      unknown.status(400);
      const text = JSON.stringify(unknown.json());
      if (!text.includes('Unknown event source \\"nope\\". Sources: composio.')) throw new Error(`error text missing: ${text}`);
      (await create({ name: 'Blank source', event_source: ' ' })).status(400);
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'Cron', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x', event_source: 'composio' },
        { params },
      );
      r.status(400);
    });
  },
);
