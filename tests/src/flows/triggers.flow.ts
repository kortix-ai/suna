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
import { enableEnterpriseDemo } from '../fixtures/enterprise-access';
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
      // A new trigger is written in the on/run shape (on: cron, run: prompt + model).
      for (const needle of ['on:', 'cron:', 'run:', 'model: anthropic/claude-sonnet-4-6', 'do nightly work']) {
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
      'the Enterprise demo is turned on (entitles this account for custom-role writes)',
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
//     trigger.fire but NOT trigger.create/update/delete. Every route loads
//     with the read floor and asserts its leaf, so:
//       GET /triggers → 200 (read passes)
//       POST /triggers → 403 (trigger.create leaf)
//       PATCH /:slug → 403 (trigger.update leaf)
//       DELETE /:slug → 403 (trigger.delete leaf)
//       PATCH /activation → 403 (trigger.update leaf)
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
    // 403 fires at the leaf, before the slug is even looked up, so a
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
      // KRTX-1505: the account has no usable model here, so the fire is gated
      // with 402 no_usable_model — recorded like any other failed fire.
      const fired = await owner.post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: { ...params, slug: 'digest' } });
      fired.status(402);
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
    // A BYOK provider key gives the account a usable model, so the fires
    // reach the backpressure path this flow exists to prove (KRTX-1505:
    // without it the no-usable-model gate 402s before queuing).
    (await owner.post(
      '/v1/projects/:projectId/secrets',
      { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-ke2e-backpressure', strategy: 'broker', consumer: 'llm_gateway' },
      { params },
    )).status(200);
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

/** App event triggers sit behind the per-project `event_triggers` flag (off by default): turn it on. */
async function enableEventTriggers(
  ctx: { step: (name: string, fn: () => Promise<void>) => Promise<void> },
  owner: { patch: (path: string, body: unknown, opts: { params: Record<string, string> }) => Promise<any> },
  projectId: string,
): Promise<void> {
  await ctx.step('turn the event_triggers flag on → 200 and it reads enabled', async () => {
    const r = await owner.patch('/v1/projects/:projectId/features', { feature: 'event_triggers', enabled: true }, { params: { projectId } });
    r.status(200);
    const row = r.json().experimental_features.find((f: { key: string }) => f.key === 'event_triggers') as { enabled: boolean } | undefined;
    if (!row?.enabled) throw new Error(`event_triggers did not turn on: ${JSON.stringify(row)}`);
  });
}

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
    await enableEventTriggers(ctx, owner, p.id);
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
    await enableEventTriggers(ctx, owner, p.id);
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
    await enableEventTriggers(ctx, ctx.client.as(ctx.P.OWNER), p.id);
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
    await enableEventTriggers(ctx, ctx.client.as(ctx.P.OWNER), p.id);
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
    await enableEventTriggers(ctx, owner, p.id);
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
    await enableEventTriggers(ctx, owner, p.id);
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

flow(
  'TRG-28',
  { domain: 'triggers', routes: ['GET /v1/projects/:projectId/triggers/event-types'] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const params = { projectId: p.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    await enableEventTriggers(ctx, owner, p.id);
    const url = '/v1/projects/:projectId/triggers/event-types';
    await ctx.step('?app= with no connector → 200 (provider configured) or 409 event_source_unavailable (local profile)', async () => {
      const r = await owner.get(url, { params, query: { app: 'github' } });
      r.status([200, 409, 404, 502]);
      if (r.json<{ error?: string }>().error === 'connector is required') throw new Error('app must not need a connector');
    });
    await ctx.step('unknown source → 400 naming the sources', async () => {
      const r = await owner.get(url, { params, query: { app: 'github', source: 'nope' } });
      r.status(400);
      if (!JSON.stringify(r.json()).includes('Unknown event source \\"nope\\". Sources: composio.')) throw new Error(`error text missing: ${JSON.stringify(r.json())}`);
    });
    await ctx.step('connector and app together → 400', async () => {
      (await owner.get(url, { params, query: { connector: 'inbox', app: 'github' } })).status(400);
    });
  },
);

flow(
  'TRG-29',
  {
    domain: 'triggers',
    routes: [
      'GET /v1/projects/:projectId/triggers/event-types',
      'GET /v1/projects/:projectId/triggers/event-apps',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'DELETE /v1/projects/:projectId/triggers/:slug',
      'PATCH /v1/projects/:projectId/features',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const types = '/v1/projects/:projectId/triggers/event-types';
    const apps = '/v1/projects/:projectId/triggers/event-apps';
    const eventBody = { name: 'Gated mail', type: 'event', connector: 'inbox', event: 'EXAMPLE_NEW_MESSAGE', prompt_template: 'x' };
    const cronBody = { name: 'Gated cron', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' };
    const denied = (r: { status: (s: number) => { body: () => { has: (path: string, value: unknown) => unknown } } }) => {
      r.status(403).body().has('$.code', 'feature_disabled');
    };
    const setFlag = async (enabled: boolean) => {
      (await owner.patch('/v1/projects/:projectId/features', { feature: 'event_triggers', enabled }, { params })).status(200);
    };

    await ctx.step('flag off (the default): event-types by connector and by app, and event-apps → 403 feature_disabled', async () => {
      denied(await owner.get(types, { params, query: { connector: 'inbox' } }));
      denied(await owner.get(types, { params, query: { app: 'github' } }));
      const r = await owner.get(apps, { params });
      denied(r);
      r.body().has('$.feature', 'event_triggers');
    });
    await ctx.step('flag off: POST of an event trigger → 403 and nothing is committed; a cron POST is still 201', async () => {
      denied(await owner.post('/v1/projects/:projectId/triggers', eventBody, { params }));
      (await owner.post('/v1/projects/:projectId/triggers', cronBody, { params })).status(201);
      const listed = (await owner.get('/v1/projects/:projectId/triggers', { params })).json<{ triggers: EventTriggerRow[] }>();
      if (listed.triggers.some((t) => t.type === 'event')) throw new Error('a refused event trigger was committed');
      if (!listed.triggers.some((t) => t.slug === 'gated-cron')) throw new Error('the cron trigger is missing');
    });
    await enableEventTriggers(ctx, owner, p.id);
    await ctx.step('the flag is on → the same calls pass the gate (404 unknown connector, 200 apps, 201 create)', async () => {
      (await owner.get(types, { params, query: { connector: 'inbox' } })).status(404);
      (await owner.get(apps, { params })).status(200);
      (await owner.post('/v1/projects/:projectId/triggers', eventBody, { params })).status(201);
    });
    await ctx.step('flag off again: the declared event trigger reads status error with the off text; PATCH of it → 403; cron PATCH → 200; DELETE → 200', async () => {
      await setFlag(false);
      const listed = (await owner.get('/v1/projects/:projectId/triggers', { params })).json<{ triggers: EventTriggerRow[] }>();
      const row = listed.triggers.find((t) => t.slug === 'gated-mail');
      if (row?.event?.status !== 'error' || !/App event triggers are off for this project/.test(row.event.error ?? '')) {
        throw new Error(`expected status error with the off text — got ${JSON.stringify(row?.event)}`);
      }
      denied(await owner.patch('/v1/projects/:projectId/triggers/:slug', { name: 'Renamed' }, { params: { ...params, slug: 'gated-mail' } }));
      (await owner.patch('/v1/projects/:projectId/triggers/:slug', { name: 'Gated cron 2' }, { params: { ...params, slug: 'gated-cron' } })).status(200);
      (await owner.del('/v1/projects/:projectId/triggers/:slug', { params: { ...params, slug: 'gated-mail' } })).status(200);
    });
  },
);

// ── Trigger run history (KRTX-1743): TRG-30 … TRG-33 ──────────────────────
// Every fire is a run. The local stack runs no sandbox and no usable model, so
// a real fire fails after authorization (402) and still writes a `failed` run.

type RunRow = {
  run_id: string;
  slug: string;
  source: string;
  status: string;
  run_status: string | null;
  error: string | null;
  session_id: string | null;
  replay_of: string | null;
  payload_verified: boolean;
  payload: Record<string, any>;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
};
type RunList = { runs: RunRow[]; next_cursor: string | null };

flow(
  'TRG-30',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
      'GET /v1/projects/:projectId/triggers/:slug/runs',
      'GET /v1/projects/:projectId/trigger-runs',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return; // the fire must fail: the local stack has no usable model
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    let runId = '';

    await ctx.step('a manual fire that fails → 402 with the run_id of the run it wrote', async () => {
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'Digest', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'Summarize.' }, { params })).status(201);
      const fired = await owner.post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: { ...params, slug: 'digest' } });
      fired.status(402);
      runId = fired.json<{ run_id?: string | null }>().run_id ?? '';
      if (!runId) throw new Error(`the failed fire named no run: ${fired.text()}`);
    });

    await ctx.step("the trigger's runs list it first: source manual, status failed, the fire's error, no session, no cost", async () => {
      const list = (await owner.get('/v1/projects/:projectId/triggers/:slug/runs', { params: { ...params, slug: 'digest' } })).status(200).json<RunList>();
      const run = list.runs[0];
      if (list.runs.length !== 1 || list.next_cursor !== null) throw new Error(`expected one run, no next page: ${JSON.stringify(list)}`);
      if (run?.run_id !== runId || run.source !== 'manual' || run.status !== 'failed' || !run.error) {
        throw new Error(`run is wrong: ${JSON.stringify(run)}`);
      }
      if (run.session_id !== null || run.cost_usd !== null || run.payload_verified !== true || run.payload.source !== 'manual') {
        throw new Error(`run fields are wrong: ${JSON.stringify(run)}`);
      }
    });

    await ctx.step('the project runs list it under ?status=failed with its slug, not under ?status=fired', async () => {
      const failed = (await owner.get('/v1/projects/:projectId/trigger-runs', { params, query: { status: 'failed' } })).status(200).json<RunList>();
      if (!failed.runs.some((r) => r.run_id === runId && r.slug === 'digest')) throw new Error(`?status=failed lacks the run: ${JSON.stringify(failed)}`);
      const fired = (await owner.get('/v1/projects/:projectId/trigger-runs', { params, query: { status: 'fired' } })).status(200).json<RunList>();
      if (fired.runs.some((r) => r.run_id === runId)) throw new Error('?status=fired lists a failed run');
    });

    await ctx.step('a bad status, limit or cursor → 400; no token → 401', async () => {
      (await owner.get('/v1/projects/:projectId/trigger-runs', { params, query: { status: 'succeeded' } })).status(400);
      (await owner.get('/v1/projects/:projectId/trigger-runs', { params, query: { limit: '101' } })).status(400);
      (await owner.get('/v1/projects/:projectId/triggers/:slug/runs', { params: { ...params, slug: 'digest' }, query: { cursor: 'nope' } })).status(400);
      (await ctx.client.as(ctx.P.ANON).get('/v1/projects/:projectId/trigger-runs', { params })).status(401);
      (await ctx.client.as(ctx.P.ANON).get('/v1/projects/:projectId/triggers/:slug/runs', { params: { ...params, slug: 'digest' } })).status(401);
    });
  },
);

flow(
  'TRG-31',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
      'GET /v1/projects/:projectId/triggers/:slug/runs',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return; // the read-back counts rows in the local database
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const fire = (body: unknown) => owner.post('/v1/projects/:projectId/triggers/:slug/fire', body, { params: { ...params, slug: 'tickets' } });
    const writes = () =>
      withDb(ctx, async (db) => {
        const count = async (table: string) =>
          Number((await db.query(`SELECT count(*)::int AS n FROM kortix.${table} WHERE project_id = $1`, [p.id])).rows[0]?.n ?? -1);
        return {
          runs: await count('project_trigger_executions'),
          sessions: await count('project_sessions'),
          commands: await count('session_lifecycle_commands'),
        };
      });
    let before = { runs: 0, sessions: 0, commands: 0 };

    await ctx.step('a keyed, filtered trigger is created', async () => {
      (
        await owner.post(
          '/v1/projects/:projectId/triggers',
          {
            name: 'Tickets',
            type: 'cron',
            cron: '0 0 9 * * *',
            timezone: 'UTC',
            prompt_template: 'Ticket {{ body.ticket }} from {{ source }}',
            session_key: '{{ body.ticket }}',
            filter: { 'body.kind': 'bug' },
          },
          { params },
        )
      ).status(201);
      before = await writes();
    });

    await ctx.step('dry_run with a payload → 200: the rendered prompt, filter verdict true, the session key, the merged payload', async () => {
      const r = await fire({ dry_run: true, payload: { body: { ticket: 'T-1', kind: 'bug' }, source: 'spoofed', actor: 'spoofed' } });
      r.status(200).body().has('$.dry_run', true).has('$.rendered_prompt', 'Ticket T-1 from manual').has('$.filter_matches', true).has('$.session_key', 'T-1');
      const payload = r.json<{ payload: Record<string, any> }>().payload;
      if (payload.body?.ticket !== 'T-1' || payload.trigger?.slug !== 'tickets' || payload.source !== 'manual' || payload.actor === 'spoofed') {
        throw new Error(`merged payload is wrong: ${JSON.stringify(payload)}`);
      }
    });

    await ctx.step('dry_run with a payload the filter rejects → filter_matches false', async () => {
      (await fire({ dry_run: true, payload: { body: { ticket: 'T-2', kind: 'feature' } } })).status(200).body().has('$.filter_matches', false);
    });

    await ctx.step('a payload that is not an object, or a dry_run that is not a boolean → 400', async () => {
      (await fire({ dry_run: true, payload: 'x' })).status(400);
      (await fire({ dry_run: 'yes' })).status(400);
    });

    await ctx.step('CLI: `kortix triggers fire tickets --payload … --dry-run --json` prints the dry run; `kortix triggers runs tickets --json` lists no run', async () => {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-trg31') });
      const sb = new CliSandbox('trg31');
      try {
        const login = await sb.login(pat, { noProject: true, account: ctx.P.accountId });
        if (login.exitCode !== 0) throw new Error(`login failed: ${login.all}`);
        const dry = await sb.run(['triggers', 'fire', 'tickets', '--payload', '{"body":{"ticket":"T-3","kind":"bug"}}', '--dry-run', '--json', '--project', p.id]);
        throwIfCliInfraFailure(dry, 'triggers fire --dry-run');
        if (dry.exitCode !== 0) throw new Error(`triggers fire --dry-run exited ${dry.exitCode}: ${dry.all}`);
        const out = JSON.parse(dry.stdout) as { dry_run: boolean; rendered_prompt: string; filter_matches: boolean; session_key: string | null };
        if (out.dry_run !== true || out.rendered_prompt !== 'Ticket T-3 from manual' || out.filter_matches !== true || out.session_key !== 'T-3') {
          throw new Error(`CLI dry run is wrong: ${dry.stdout}`);
        }
        const listed = await sb.run(['triggers', 'runs', 'tickets', '--json', '--project', p.id]);
        throwIfCliInfraFailure(listed, 'triggers runs');
        if (listed.exitCode !== 0) throw new Error(`triggers runs exited ${listed.exitCode}: ${listed.all}`);
        const list = JSON.parse(listed.stdout) as RunList;
        if (list.runs.length !== 0 || list.next_cursor !== null) throw new Error(`CLI runs list is wrong: ${listed.stdout}`);
      } finally {
        sb.dispose();
      }
    });

    await ctx.step('read-back: no run row, no session, no command; the runs list is empty and last_fired_at is unset', async () => {
      const after = await writes();
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`dry run wrote rows: ${JSON.stringify({ before, after })}`);
      const list = (await owner.get('/v1/projects/:projectId/triggers/:slug/runs', { params: { ...params, slug: 'tickets' } })).status(200).json<RunList>();
      if (list.runs.length !== 0) throw new Error(`dry run listed a run: ${JSON.stringify(list)}`);
      const row = (await owner.get('/v1/projects/:projectId/triggers', { params })).json<{ triggers: Array<{ slug: string; last_fired_at: string | null; last_status: string | null }> }>()
        .triggers.find((t) => t.slug === 'tickets');
      if (row?.last_fired_at || row?.last_status) throw new Error(`dry run changed the trigger state: ${JSON.stringify(row)}`);
    });
  },
);

flow(
  'TRG-32',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/secrets',
      'DELETE /v1/projects/:projectId/secrets/:name',
      'POST /v1/projects/:projectId/triggers',
      'POST /v1/webhooks/projects/:projectId/:slug',
      'GET /v1/projects/:projectId/triggers/:slug/runs',
      'POST /v1/projects/:projectId/triggers/:slug/runs/:run_id/replay',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return; // the replay must fail: the local stack has no usable model
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const secret = `ke2e-hook-${crypto.randomUUID()}`;
    const rawBody = JSON.stringify({ action: 'opened', api_key: 'synthetic-not-a-key' });
    const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const addSecret = async () =>
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'HOOK_SECRET', value: secret, strategy: 'broker', consumer: 'connector' }, { params })).status(200);
    const runs = async (slug = 'hook') =>
      (await owner.get('/v1/projects/:projectId/triggers/:slug/runs', { params: { ...params, slug } })).status(200).json<RunList>().runs;
    const replay = (runId: string, body: unknown, slug = 'hook') =>
      owner.post('/v1/projects/:projectId/triggers/:slug/runs/:run_id/replay', body, { params: { ...params, slug, run_id: runId } });
    let rejected: RunRow | undefined;
    let replayedId = '';

    await ctx.step('a webhook trigger whose secret is then deleted: a signed delivery → 401', async () => {
      await addSecret();
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'hook', slug: 'hook', type: 'webhook', secret_env: 'HOOK_SECRET', prompt_template: 'New {{ body.action }}' }, { params })).status(201);
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'Other', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'x' }, { params })).status(201);
      (await owner.del('/v1/projects/:projectId/secrets/:name', { params: { ...params, name: 'HOOK_SECRET' } })).status(200);
      (
        await ctx.client.as(ctx.P.ANON).post('/v1/webhooks/projects/:projectId/:slug', rawBody, {
          params: { ...params, slug: 'hook' },
          raw: true,
          headers: { 'content-type': 'application/json', 'x-kortix-signature': signature },
        })
      ).status(401);
    });

    await ctx.step('the delivery is a rejected run: unverified, with the reason and the payload, its api_key redacted', async () => {
      const listed = await waitFor(runs, { until: (r) => r.some((run) => run.status === 'rejected'), timeoutMs: 10_000, intervalMs: 250, description: 'rejected run' });
      rejected = listed.find((run) => run.status === 'rejected');
      if (!rejected || rejected.source !== 'webhook' || rejected.payload_verified !== false || !rejected.error) {
        throw new Error(`rejected run is wrong: ${JSON.stringify(rejected)}`);
      }
      if (rejected.payload.body?.action !== 'opened' || rejected.payload.body?.api_key !== '[redacted]') {
        throw new Error(`rejected payload is wrong: ${JSON.stringify(rejected.payload)}`);
      }
    });

    await ctx.step('replay without confirm_unverified → 409 payload_unverified; another trigger or an unknown run → 404', async () => {
      (await replay(rejected!.run_id, {})).status(409).body().has('$.code', 'payload_unverified');
      (await replay(rejected!.run_id, { confirm_unverified: true }, 'other')).status(404);
      (await replay(crypto.randomUUID(), { confirm_unverified: true })).status(404);
    });

    await ctx.step('CLI: `kortix triggers replay hook <run_id>` on the unverified run exits 1 and names --confirm-unverified', async () => {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-trg32') });
      const sb = new CliSandbox('trg32');
      try {
        const login = await sb.login(pat, { noProject: true, account: ctx.P.accountId });
        if (login.exitCode !== 0) throw new Error(`login failed: ${login.all}`);
        const r = await sb.run(['triggers', 'replay', 'hook', rejected!.run_id, '--project', p.id]);
        throwIfCliInfraFailure(r, 'triggers replay');
        if (r.exitCode !== 1 || !r.stderr.includes('--confirm-unverified')) {
          throw new Error(`CLI replay of an unverified run: exit ${r.exitCode}: ${r.all}`);
        }
      } finally {
        sb.dispose();
      }
    });

    await ctx.step('the secret is restored; replay with confirm_unverified → the fire path answers (402) with a new run', async () => {
      await addSecret();
      const r = await replay(rejected!.run_id, { confirm_unverified: true });
      r.status(402);
      const runId = r.json<{ run_id?: string | null }>().run_id;
      const replayed = (await runs()).find((run) => run.run_id === runId);
      if (!replayed || replayed.replay_of !== rejected!.run_id || replayed.source !== 'webhook' || replayed.status !== 'failed') {
        throw new Error(`replayed run is wrong: ${JSON.stringify(replayed)}`);
      }
      if (replayed.payload.body?.action !== 'opened') throw new Error(`replay did not carry the stored payload: ${JSON.stringify(replayed.payload)}`);
      replayedId = replayed.run_id;
    });

    await ctx.step('the replay of an unverified payload stays unverified: payload_verified false, and replaying it without confirm → 409', async () => {
      const replayed = (await runs()).find((run) => run.run_id === replayedId);
      if (replayed?.payload_verified !== false) throw new Error(`replayed run reads verified: ${JSON.stringify(replayed)}`);
      (await replay(replayedId, {})).status(409).body().has('$.code', 'payload_unverified');
    });

    await ctx.step('a run still in progress (a requeued create) → replay 409 run_in_progress', async () => {
      const inProgressId = await withDb(ctx, async (db) =>
        (
          await db.query(
            `INSERT INTO kortix.project_trigger_executions
               (project_id, slug, schedule_revision, scheduled_for, status, spec, payload, source)
             VALUES ($1, 'hook', 'webhook:' || gen_random_uuid(), now(), 'requeued', '{}'::jsonb, '{"body":{}}'::jsonb, 'webhook')
             RETURNING execution_id`,
            [p.id],
          )
        ).rows[0]?.execution_id as string,
      );
      (await replay(inProgressId, {})).status(409).body().has('$.code', 'run_in_progress');
    });

    await ctx.step('a run whose payload was truncated → replay 422 payload_truncated', async () => {
      await withDb(ctx, (db) =>
        db.query(`UPDATE kortix.project_trigger_executions SET payload = '{"truncated":true,"bytes":70000}'::jsonb WHERE execution_id = $1`, [rejected!.run_id]),
      );
      (await replay(rejected!.run_id, { confirm_unverified: true })).status(422).body().has('$.code', 'payload_truncated');
    });
  },
);

flow(
  'TRG-33',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers/:slug/runs',
      'GET /v1/projects/:projectId/trigger-runs',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return; // runs, a session and LLM spend are seeded in the local database
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'user');
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id };
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: crypto.randomUUID(),
      visibility: 'private',
      metadata: { source: 'trigger:scheduler', trigger_kind: 'git', trigger_slug: 'nightly' },
    });
    const list = async (as: typeof owner, query: Record<string, string> = {}) =>
      (await as.get('/v1/projects/:projectId/triggers/:slug/runs', { params: { ...params, slug: 'nightly' }, query })).status(200).json<RunList>();

    // Teardown keeps the team account (an earlier run left its rows), so the seeded
    // gateway logs are deleted here, pass or fail.
    try {
      await ctx.step('seed: three manual runs and one cron slot with no session, one run of a private trigger session, and the session\'s LLM spend', async () => {
        (await owner.post('/v1/projects/:projectId/triggers', { name: 'Nightly', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'x' }, { params })).status(201);
        await withDb(ctx, async (db) => {
          for (const minutes of [3, 2, 1]) {
            await db.query(
              `INSERT INTO kortix.project_trigger_executions
                 (project_id, slug, schedule_revision, scheduled_for, status, spec, payload, source, created_at, completed_at)
               VALUES ($1, 'nightly', 'manual:' || gen_random_uuid(), now() - make_interval(mins => $2), 'failed', '{}'::jsonb,
                       '{"source":"manual"}'::jsonb, 'manual', now() - make_interval(mins => $2), now() - make_interval(mins => $2))`,
              [project.id, minutes],
            );
          }
          await db.query(
            `INSERT INTO kortix.project_trigger_executions
               (project_id, slug, schedule_revision, scheduled_for, status, spec, payload, source, session_id,
                run_status, run_ended_at, created_at, completed_at)
             VALUES ($1, 'nightly', 'manual:' || gen_random_uuid(), now() - interval '10 min', 'succeeded', '{}'::jsonb,
                     '{"body":{"ticket":"T-9","api_key":"synthetic-not-a-key"}}'::jsonb, 'manual', $2,
                     'succeeded', now() - interval '5 min', now() - interval '10 min', now() - interval '10 min')`,
            [project.id, sessionId],
          );
          // A cron slot row, as the scheduler's claim writes it: the default `source` (cron).
          await db.query(
            `INSERT INTO kortix.project_trigger_executions
               (project_id, slug, schedule_revision, scheduled_for, status, spec, payload, claimed_at, created_at, completed_at)
             VALUES ($1, 'nightly', 'ke2e-slot-revision', now() - interval '4 min', 'succeeded', '{}'::jsonb,
                     '{"cron":{"schedule":"0 0 3 * * *"}}'::jsonb, now() - interval '4 min', now() - interval '4 min', now() - interval '4 min')`,
            [project.id],
          );
          for (const [minutes, cost] of [[8, '0.25'], [1, '1.0']] as const) {
            await db.query(
              `INSERT INTO kortix.gateway_request_logs
                 (request_id, account_id, project_id, session_id, requested_model, resolved_model, provider, status, ok,
                  final_cost_precise, billing_mode, created_at)
               VALUES (gen_random_uuid()::text, $1, $2, $3, 'ke2e/model', 'ke2e/model', 'ke2e', 200, true, $4::numeric, 'credits',
                       now() - make_interval(mins => $5))`,
              [team.id, project.id, sessionId, cost, minutes],
            );
          }
        });
      });

      await ctx.step('the owner sees all five, newest first; the cron slot lists with source cron; the session run shows its window cost, duration and a redacted payload', async () => {
        const runs = (await list(owner)).runs;
        if (runs.length !== 5 || runs[4]?.session_id !== sessionId) throw new Error(`owner list is wrong: ${JSON.stringify(runs)}`);
        const cron = runs[3]!;
        if (cron.source !== 'cron' || cron.status !== 'fired' || cron.session_id !== null || cron.payload.cron?.schedule !== '0 0 3 * * *') {
          throw new Error(`cron run is wrong: ${JSON.stringify(cron)}`);
        }
        const run = runs[4]!;
        // Only the 0.25 inside [started_at, ended_at] counts; the 1.0 after ended_at does not.
        if (run.status !== 'fired' || run.run_status !== 'succeeded' || run.cost_usd !== 0.25 || run.duration_ms !== 300_000) {
          throw new Error(`session run is wrong: ${JSON.stringify(run)}`);
        }
        if (run.payload.body?.api_key !== '[redacted]' || run.payload.body?.ticket !== 'T-9') throw new Error(`payload not redacted: ${JSON.stringify(run.payload)}`);
      });

      await ctx.step('limit=2 pages the owner\'s five runs: two, two, then one with next_cursor null', async () => {
        const first = await list(owner, { limit: '2' });
        if (first.runs.length !== 2 || !first.next_cursor) throw new Error(`first page is wrong: ${JSON.stringify(first)}`);
        const second = await list(owner, { limit: '2', cursor: first.next_cursor });
        if (second.runs.length !== 2 || !second.next_cursor) throw new Error(`second page is wrong: ${JSON.stringify(second)}`);
        const third = await list(owner, { limit: '2', cursor: second.next_cursor });
        if (third.runs.length !== 1 || third.next_cursor !== null) throw new Error(`third page is wrong: ${JSON.stringify(third)}`);
        const ids = new Set([...first.runs, ...second.runs, ...third.runs].map((r) => r.run_id));
        if (ids.size !== 5) throw new Error('pages overlap');
      });

      await ctx.step('a tampered cursor (well-formed base64 JSON: impossible timestamp, impossible calendar day, or a non-UUID id) → 400, not 500', async () => {
        const forge = (createdAt: string, executionId: string = crypto.randomUUID()) =>
          Buffer.from(JSON.stringify([createdAt, executionId])).toString('base64url');
        const forged = [
          forge('2026-13-45 99:99:99+00'),
          forge('2026-10-16T18:03:54Z'),
          forge("now()'; --"),
          forge('2026-02-30 00:00:00+00'), // an impossible calendar day that Date.parse accepts
          forge('2026-10-16 18:03:54+00', '-'.repeat(36)), // 36 dashes, not a UUID
        ];
        for (const cursor of forged) {
          (await owner.get('/v1/projects/:projectId/triggers/:slug/runs', { params: { ...params, slug: 'nightly' }, query: { cursor } })).status(400);
        }
      });

      await ctx.step('a member who may not open the private session sees only the four runs without a session, in both lists', async () => {
        const asMember = ctx.client.as(member);
        const runs = (await list(asMember)).runs;
        if (runs.length !== 4 || runs.some((r) => r.session_id !== null)) throw new Error(`member trigger list is wrong: ${JSON.stringify(runs)}`);
        const project_runs = (await asMember.get('/v1/projects/:projectId/trigger-runs', { params })).status(200).json<RunList>().runs;
        if (project_runs.length !== 4 || project_runs.some((r) => r.session_id === sessionId)) {
          throw new Error(`member project list is wrong: ${JSON.stringify(project_runs)}`);
        }
      });
    } finally {
      await withDb(ctx, (db) => db.query('DELETE FROM kortix.gateway_request_logs WHERE session_id = $1', [sessionId]));
    }
  },
);

// TRG-34 — Kortix's own app-event source `mcp` (connectors_v2): the catalog apps
// list as event apps with their MCP server, a project MCP server is an event app
// of its own, an event the connector does not offer is refused, and a project
// without connectors_v2 sees no `mcp` source at all.
flow(
  'TRG-34',
  {
    domain: 'triggers',
    routes: [
      'GET /v1/projects/:projectId/triggers/event-apps',
      'GET /v1/projects/:projectId/triggers/event-types',
      'POST /v1/connectors/projects/:projectId/connectors',
      'POST /v1/projects/:projectId/triggers',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const on = await ctx.fixtures.project({ managedGit: true, metadata: { experimental: { event_triggers: true, connectors_v2: true } } });
    const off = await ctx.fixtures.project({ metadata: { experimental: { event_triggers: true } } });
    type App = { source: string; app: string; event_count: number; connector: string | null; connected: boolean; mcp_url: string | null };
    const apps = async (projectId: string) =>
      (await owner.get('/v1/projects/:projectId/triggers/event-apps', { params: { projectId } })).status(200).json<{ apps: App[] }>().apps;

    await ctx.step('connectors_v2 on: catalog apps with sign-in are event apps of source mcp, with the MCP server to install', async () => {
      const list = await apps(on.id);
      const linear = list.find((a) => a.app === 'linear');
      if (!linear || linear.source !== 'mcp' || linear.mcp_url !== 'https://mcp.linear.app/mcp' || linear.connector !== null || linear.connected) {
        throw new Error(`linear entry is wrong: ${JSON.stringify(linear)}`);
      }
      if (list.some((a) => a.app === 'deepwiki')) throw new Error('a server with no sign-in has no account to watch, so it is not an event app');
    });

    await ctx.step('an uninstalled catalog app answers 200 with no events yet; an unknown app → 404', async () => {
      const params = { projectId: on.id };
      const r = await owner.get('/v1/projects/:projectId/triggers/event-types', { params, query: { app: 'linear', source: 'mcp' } });
      r.status(200).body().has('$.source', 'mcp');
      if (r.json<{ event_types: unknown[] }>().event_types.length !== 0) throw new Error(`expected no events: ${r.text()}`);
      (await owner.get('/v1/projects/:projectId/triggers/event-types', { params, query: { app: 'no-such-app', source: 'mcp' } })).status(404);
    });

    await ctx.step('a project MCP server is an event app of its own; with no list tool read yet it offers no event', async () => {
      const params = { projectId: on.id };
      // auth set explicitly: the create route then skips its live discovery probe of this unreachable url.
      (await owner.post('/v1/connectors/projects/:projectId/connectors', { slug: 'inbox', provider: 'mcp', url: 'https://ke2e.kortix.test/mcp', auth: { type: 'none' } }, { params }))
        .status(200);
      const inbox = (await apps(on.id)).find((a) => a.app === 'inbox');
      if (!inbox || inbox.source !== 'mcp' || inbox.connector !== 'inbox' || inbox.mcp_url !== null || inbox.event_count !== 0) {
        throw new Error(`inbox entry is wrong: ${JSON.stringify(inbox)}`);
      }
      const r = await owner.get('/v1/projects/:projectId/triggers/event-types', { params, query: { connector: 'inbox' } });
      r.status(200).body().has('$.source', 'mcp').has('$.app', 'inbox');
      if (r.json<{ event_types: unknown[] }>().event_types.length !== 0) throw new Error(`expected no events: ${r.text()}`);
    });

    await ctx.step('an event the connector does not offer → 400 that names the command to list its events', async () => {
      const r = await owner.post(
        '/v1/projects/:projectId/triggers',
        { name: 'New inbox item', type: 'event', connector: 'inbox', event: 'new_item.list_items', event_config: { interval: 5 }, prompt_template: 'x' },
        { params: { projectId: on.id } },
      );
      r.status(400);
      if (!r.text().includes('Unknown event new_item.list_items for inbox. Run kortix triggers events --connector inbox.')) {
        throw new Error(`unexpected refusal: ${r.text()}`);
      }
    });

    await ctx.step('connectors_v2 off: no mcp source in the listing, and source=mcp → 400 that lists the sources', async () => {
      if ((await apps(off.id)).some((a) => a.source === 'mcp')) throw new Error('mcp apps listed without connectors_v2');
      const r = await owner.get('/v1/projects/:projectId/triggers/event-types', { params: { projectId: off.id }, query: { app: 'linear', source: 'mcp' } });
      r.status(400).body().has('$.error', 'Unknown event source "mcp". Sources: composio.');
    });
  },
);

/**
 * TRG-35 — run limits (KRTX-1721). A trigger starts at most
 * `max_runs_per_hour` runs in any 60 minutes (60 when unset) and at most
 * `max_runs_per_day` in a UTC day. A fire past a limit starts nothing: a
 * webhook answers `200 skipped` with a `throttled:` reason and the run history
 * keeps a skipped run. A person's manual fire is never held. Local only: the
 * started run inside the window is seeded in the database.
 */
flow(
  'TRG-35',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'POST /v1/webhooks/projects/:projectId/:slug',
      'GET /v1/projects/:projectId/triggers/:slug/runs',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return;
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const secret = `ke2e-capped-${crypto.randomUUID()}`;
    type Listed = { slug: string; max_runs_per_hour?: number | null; max_runs_per_day?: number | null };
    const limits = async (slug: string) => {
      const t = (await owner.get('/v1/projects/:projectId/triggers', { params })).status(200).json<{ triggers: Listed[] }>().triggers.find((row) => row.slug === slug);
      if (!t) throw new Error(`trigger ${slug} is not listed`);
      return [t.max_runs_per_hour ?? null, t.max_runs_per_day ?? null];
    };
    const expectLimits = async (slug: string, expected: Array<number | null>) => {
      const got = await limits(slug);
      if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${slug} limits: ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    };
    const throttled = 'throttled: 1 runs in the last hour (max_runs_per_hour 1)';

    await ctx.step('a run limit that is not a whole number of at least 1 → 400 naming the field', async () => {
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'Bad', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'x', max_runs_per_hour: 0 }, { params }))
        .status(400).body().has('$.error', 'max_runs_per_hour must be a whole number of at least 1');
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'Bad', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'x', max_runs_per_day: 1.5 }, { params }))
        .status(400).body().has('$.error', 'max_runs_per_day must be a whole number of at least 1');
    });

    await ctx.step('a webhook trigger with max_runs_per_hour 1 → 201 and reads 1 / null; a trigger without limits reads null / null', async () => {
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'HOOK_SECRET', value: secret, strategy: 'broker', consumer: 'connector' }, { params })).status(200);
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'capped', slug: 'capped', type: 'webhook', secret_env: 'HOOK_SECRET', prompt_template: 'New {{ body.action }}', max_runs_per_hour: 1 }, { params })).status(201);
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'Plain', slug: 'plain', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'x' }, { params })).status(201);
      await expectLimits('capped', [1, null]);
      await expectLimits('plain', [null, null]);
    });

    await ctx.step('a PATCH of another field keeps the limits; max_runs_per_day 5 sets it, null removes it', async () => {
      (await owner.patch('/v1/projects/:projectId/triggers/:slug', { prompt_template: 'Changed {{ body.action }}' }, { params: { ...params, slug: 'capped' } })).status(200);
      await expectLimits('capped', [1, null]);
      (await owner.patch('/v1/projects/:projectId/triggers/:slug', { max_runs_per_day: 5 }, { params: { ...params, slug: 'capped' } })).status(200);
      await expectLimits('capped', [1, 5]);
      (await owner.patch('/v1/projects/:projectId/triggers/:slug', { max_runs_per_day: null }, { params: { ...params, slug: 'capped' } })).status(200);
      await expectLimits('capped', [1, null]);
    });

    await ctx.step('with one run started in the last hour, a signed delivery → 200 skipped "throttled: …", a skipped run, and no session', async () => {
      await withDb(ctx, (db) =>
        db.query(
          `INSERT INTO kortix.project_trigger_executions (project_id, slug, schedule_revision, scheduled_for, status, spec, payload, source, created_at)
           VALUES ($1, 'capped', 'webhook:' || gen_random_uuid(), now(), 'succeeded', '{}'::jsonb, '{"body":{}}'::jsonb, 'webhook', now() - interval '5 minutes')`,
          [p.id],
        ),
      );
      const rawBody = JSON.stringify({ action: 'opened' });
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/webhooks/projects/:projectId/:slug', rawBody, {
        params: { ...params, slug: 'capped' },
        raw: true,
        headers: {
          'content-type': 'application/json',
          'x-kortix-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
          'x-kortix-delivery-id': crypto.randomUUID(),
        },
      });
      r.status(200).body().has('$.status', 'skipped').has('$.reason', throttled);
      const runs = (await owner.get('/v1/projects/:projectId/triggers/:slug/runs', { params: { ...params, slug: 'capped' } })).status(200).json<RunList>().runs;
      const skipped = runs.find((run) => run.status === 'skipped');
      if (!skipped || skipped.error !== throttled || skipped.source !== 'webhook' || skipped.session_id !== null) {
        throw new Error(`throttled run is wrong: ${JSON.stringify(runs)}`);
      }
      const sessions = await withDb(ctx, async (db) =>
        Number((await db.query(`SELECT count(*) AS n FROM kortix.project_sessions WHERE project_id = $1 AND metadata->>'trigger_slug' = 'capped'`, [p.id])).rows[0]?.n ?? 0),
      );
      if (sessions !== 0) throw new Error(`a throttled delivery created ${sessions} session(s)`);
    });

    await ctx.step('a manual fire past the limit is not held: it reaches the fire path (402, no usable model locally), not skipped', async () => {
      const r = await owner.post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: { ...params, slug: 'capped' } });
      r.status(402);
    });

    await ctx.step('CLI: `kortix triggers set capped --max-runs-per-day 3` sets it, `none` removes it, `--max-runs-per-hour 0` exits 2 naming the flag', async () => {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-trg35') });
      const sb = new CliSandbox('trg35');
      try {
        const login = await sb.login(pat, { noProject: true, account: ctx.P.accountId });
        if (login.exitCode !== 0) throw new Error(`login failed: ${login.all}`);
        const set = await sb.run(['triggers', 'set', 'capped', '--max-runs-per-day', '3', '--project', p.id]);
        throwIfCliInfraFailure(set, 'triggers set');
        if (set.exitCode !== 0) throw new Error(`set --max-runs-per-day 3: exit ${set.exitCode}: ${set.all}`);
        await expectLimits('capped', [1, 3]);
        const info = await sb.run(['triggers', 'info', 'capped', '--project', p.id]);
        if (info.exitCode !== 0 || !/max_runs_per_hour\s+1\b/.test(info.stdout) || !/max_runs_per_day\s+3\b/.test(info.stdout)) {
          throw new Error(`info does not show the limits: exit ${info.exitCode}: ${info.all}`);
        }
        const clear = await sb.run(['triggers', 'set', 'capped', '--max-runs-per-day', 'none', '--project', p.id]);
        if (clear.exitCode !== 0) throw new Error(`set --max-runs-per-day none: exit ${clear.exitCode}: ${clear.all}`);
        await expectLimits('capped', [1, null]);
        const bad = await sb.run(['triggers', 'set', 'capped', '--max-runs-per-hour', '0', '--project', p.id]);
        // A bad flag value is a usage error: exit 2, like every other `triggers` flag check.
        if (bad.exitCode !== 2 || !bad.stderr.includes('--max-runs-per-hour must be a whole number of at least 1')) {
          throw new Error(`set --max-runs-per-hour 0: exit ${bad.exitCode}: ${bad.all}`);
        }
      } finally {
        sb.dispose();
      }
    });
  },
);

/**
 * TRG-36 — Pause all automations (KRTX-1721). One account switch stops every
 * automatic fire in every project of the account; a manual fire still runs.
 * On its own team account: the switch would otherwise pause every concurrent
 * flow on the shared one. Local only: a fire that runs answers 402 (no usable
 * model) here, which tells it apart from `200 skipped`.
 */
flow(
  'TRG-36',
  {
    domain: 'triggers',
    routes: [
      'GET /v1/accounts/:accountId/automations',
      'PATCH /v1/accounts/:accountId/automations',
      'POST /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/webhooks/projects/:projectId/:slug',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return;
    const team = await ctx.fixtures.team();
    const p = await team.project({ managedGit: true });
    const member = await team.addMember('member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const memberClient = ctx.client.as(member);
    const params = { projectId: p.id };
    const account = { accountId: team.id };
    const secret = `ke2e-pause-${crypto.randomUUID()}`;
    type Status = { paused: boolean; paused_at: string | null; paused_by: string | null; can_change: boolean };
    const deliver = async () => {
      const rawBody = JSON.stringify({ action: 'opened' });
      return ctx.client.as(ctx.P.ANON).post('/v1/webhooks/projects/:projectId/:slug', rawBody, {
        params: { ...params, slug: 'hook' },
        raw: true,
        headers: {
          'content-type': 'application/json',
          'x-kortix-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
          'x-kortix-delivery-id': crypto.randomUUID(),
        },
      });
    };
    const listingPaused = async () =>
      (await owner.get('/v1/projects/:projectId/triggers', { params })).status(200).json<{ account_automations_paused?: boolean }>().account_automations_paused;

    await ctx.step('setup: a webhook trigger on the team project', async () => {
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'HOOK_SECRET', value: secret, strategy: 'broker', consumer: 'connector' }, { params })).status(200);
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'hook', slug: 'hook', type: 'webhook', secret_env: 'HOOK_SECRET', prompt_template: 'New {{ body.action }}' }, { params })).status(201);
    });

    await ctx.step('GET automations: running; the owner may change it, a member may read it but not change it, an outsider → 403', async () => {
      (await owner.get('/v1/accounts/:accountId/automations', { params: account })).status(200).body().has('$.paused', false).has('$.can_change', true);
      (await memberClient.get('/v1/accounts/:accountId/automations', { params: account })).status(200).body().has('$.paused', false).has('$.can_change', false);
      (await ctx.client.as(ctx.P.NONMEMBER).get('/v1/accounts/:accountId/automations', { params: account })).status(403);
    });

    await ctx.step('a member cannot pause → 403; the owner pauses → 200 with paused_at and paused_by; the listing says so', async () => {
      (await memberClient.patch('/v1/accounts/:accountId/automations', { paused: true }, { params: account })).status(403);
      const s = (await owner.patch('/v1/accounts/:accountId/automations', { paused: true }, { params: account })).status(200).json<Status>();
      if (!s.paused || !s.paused_at || s.paused_by !== ctx.P.OWNER.userId) throw new Error(`pause status is wrong: ${JSON.stringify(s)}`);
      if ((await listingPaused()) !== true) throw new Error('the trigger listing does not say the account is paused');
    });

    await ctx.step('while paused, a signed delivery → 200 skipped "account automations are paused"; a manual fire still runs (402)', async () => {
      (await deliver()).status(200).body().has('$.status', 'skipped').has('$.reason', 'account automations are paused');
      (await owner.post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: { ...params, slug: 'hook' } })).status(402);
    });

    await ctx.step('resumed: the switch reads running and a delivery reaches the fire path again (402, not skipped)', async () => {
      (await owner.patch('/v1/accounts/:accountId/automations', { paused: false }, { params: account })).status(200).body().has('$.paused', false).has('$.paused_by', null);
      if ((await listingPaused()) !== false) throw new Error('the trigger listing still says the account is paused');
      (await deliver()).status(402);
    });

    await ctx.step('CLI: `kortix triggers pause --account-wide` pauses the account, `resume --account-wide` resumes it', async () => {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-trg36') });
      const sb = new CliSandbox('trg36');
      try {
        const login = await sb.login(pat, { noProject: true, account: team.id });
        if (login.exitCode !== 0) throw new Error(`login failed: ${login.all}`);
        const pause = await sb.run(['triggers', 'pause', '--account-wide']);
        throwIfCliInfraFailure(pause, 'triggers pause --account-wide');
        if (pause.exitCode !== 0 || !pause.stdout.includes('All automations PAUSED')) throw new Error(`pause --account-wide: exit ${pause.exitCode}: ${pause.all}`);
        (await owner.get('/v1/accounts/:accountId/automations', { params: account })).status(200).body().has('$.paused', true);
        const resume = await sb.run(['triggers', 'resume', '--account-wide']);
        if (resume.exitCode !== 0 || !resume.stdout.includes('All automations RESUMED')) throw new Error(`resume --account-wide: exit ${resume.exitCode}: ${resume.all}`);
        (await owner.get('/v1/accounts/:accountId/automations', { params: account })).status(200).body().has('$.paused', false);
      } finally {
        sb.dispose();
      }
    });
  },
);

/**
 * TRG-37 — filter operators (KRTX-1721). A filter path takes a value (equals)
 * or one operator: `not`, `in`, `exists`, `prefix`, `not_prefix`. The
 * loop-breaking case: a push webhook whose agent pushes on `kortix/*` branches
 * skips the agent's own pushes and still fires for a person. Local only.
 */
flow(
  'TRG-37',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'POST /v1/webhooks/projects/:projectId/:slug',
      'GET /v1/projects/:projectId/triggers/:slug/runs',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return;
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const slugParams = { ...params, slug: 'loop-safe' };
    const secret = `ke2e-loop-safe-${crypto.randomUUID()}`;
    const listedFilter = async () => {
      const t = (await owner.get('/v1/projects/:projectId/triggers', { params })).status(200)
        .json<{ triggers: Array<{ slug: string; filter: unknown }> }>().triggers.find((row) => row.slug === 'loop-safe');
      if (!t) throw new Error('loop-safe is not listed');
      return t.filter;
    };
    const deliver = async (body: Record<string, unknown>) => {
      const rawBody = JSON.stringify(body);
      return ctx.client.as(ctx.P.ANON).post('/v1/webhooks/projects/:projectId/:slug', rawBody, {
        params: slugParams,
        raw: true,
        headers: {
          'content-type': 'application/json',
          'x-kortix-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
          'x-kortix-delivery-id': crypto.randomUUID(),
        },
      });
    };
    const push = (ref: string, login: string) => ({ ref, sender: { login } });
    const unmatched = 'delivery did not match the trigger filter';

    await ctx.step('an unknown operator, two operators on one path, and an empty list → 400 naming the path', async () => {
      const create = (filter: unknown) =>
        owner.post('/v1/projects/:projectId/triggers', { name: 'Bad', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'x', filter }, { params });
      (await create({ 'body.ref': { nott: 'x' } })).status(400)
        .body().has('$.error', 'filter.body.ref has an unknown operator "nott"; use one of: not, in, exists, prefix, not_prefix');
      (await create({ 'body.ref': { in: ['a'], not: 'b' } })).status(400).body().has('$.error', 'filter.body.ref takes one operator, got 2: in, not');
      (await create({ 'body.action': { in: [] } })).status(400).body().has('$.error', 'filter.body.action.in must list at least one value');
    });

    await ctx.step('a webhook trigger with not_prefix and not → 201; the listing stores each operator as a list', async () => {
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'HOOK_SECRET', value: secret, strategy: 'broker', consumer: 'connector' }, { params })).status(200);
      (await owner.post('/v1/projects/:projectId/triggers', {
        name: 'loop-safe', slug: 'loop-safe', type: 'webhook', secret_env: 'HOOK_SECRET', prompt_template: 'Lint {{ body.ref }}',
        filter: { 'body.ref': { not_prefix: 'refs/heads/kortix/' }, 'body.sender.login': { not: ['kortix-bot'] } },
      }, { params })).status(201);
      const filter = await listedFilter();
      const expected = { 'body.ref': { not_prefix: ['refs/heads/kortix/'] }, 'body.sender.login': { not: ['kortix-bot'] } };
      if (JSON.stringify(filter) !== JSON.stringify(expected)) throw new Error(`listed filter ${JSON.stringify(filter)}, expected ${JSON.stringify(expected)}`);
    });

    await ctx.step("the agent's own branch and the agent's own sender → 200 skipped, two skipped runs, no session", async () => {
      (await deliver(push('refs/heads/kortix/fix-lint', 'a-person'))).status(200).body().has('$.status', 'skipped').has('$.reason', unmatched);
      (await deliver(push('refs/heads/main', 'kortix-bot'))).status(200).body().has('$.status', 'skipped').has('$.reason', unmatched);
      const runs = (await owner.get('/v1/projects/:projectId/triggers/:slug/runs', { params: slugParams })).status(200).json<RunList>().runs;
      const skipped = runs.filter((run) => run.status === 'skipped' && run.error === unmatched && run.session_id === null);
      if (skipped.length !== 2) throw new Error(`expected 2 skipped runs: ${JSON.stringify(runs)}`);
      const sessions = await withDb(ctx, async (db) =>
        Number((await db.query(`SELECT count(*) AS n FROM kortix.project_sessions WHERE project_id = $1 AND metadata->>'trigger_slug' = 'loop-safe'`, [p.id])).rows[0]?.n ?? 0),
      );
      if (sessions !== 0) throw new Error(`a filtered delivery created ${sessions} session(s)`);
    });

    await ctx.step("a dry run reports a person's push on main as a match and the agent's branch as no match", async () => {
      const dry = async (payload: Record<string, unknown>) =>
        owner.post('/v1/projects/:projectId/triggers/:slug/fire', { dry_run: true, payload: { body: payload } }, { params: slugParams });
      (await dry(push('refs/heads/main', 'a-person'))).status(200).body().has('$.filter_matches', true);
      (await dry(push('refs/heads/kortix/fix-lint', 'a-person'))).status(200).body().has('$.filter_matches', false);
    });

    await ctx.step('CLI: `--filter path:op=value` replaces the filter with in and exists; `exists=maybe` exits 2 before any request', async () => {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-trg37') });
      const sb = new CliSandbox('trg37');
      try {
        const login = await sb.login(pat, { noProject: true, account: ctx.P.accountId });
        if (login.exitCode !== 0) throw new Error(`login failed: ${login.all}`);
        const set = await sb.run(['triggers', 'set', 'loop-safe', '--filter', 'body.action:in=opened,reopened', '--filter', 'body.pull_request:exists=true', '--project', p.id]);
        throwIfCliInfraFailure(set, 'triggers set');
        if (set.exitCode !== 0) throw new Error(`set --filter: exit ${set.exitCode}: ${set.all}`);
        const filter = await listedFilter();
        const expected = { 'body.action': { in: ['opened', 'reopened'] }, 'body.pull_request': { exists: true } };
        if (JSON.stringify(filter) !== JSON.stringify(expected)) throw new Error(`listed filter ${JSON.stringify(filter)}, expected ${JSON.stringify(expected)}`);
        const bad = await sb.run(['triggers', 'set', 'loop-safe', '--filter', 'body.pull_request:exists=maybe', '--project', p.id]);
        if (bad.exitCode !== 2 || !bad.stderr.includes('--filter body.pull_request:exists takes true or false (got "maybe")')) {
          throw new Error(`set --filter exists=maybe: exit ${bad.exitCode}: ${bad.all}`);
        }
        if (JSON.stringify(await listedFilter()) !== JSON.stringify(expected)) throw new Error('a rejected --filter changed the stored filter');
      } finally {
        sb.dispose();
      }
    });
  },
);

/**
 * TRG-38 — auto-pause (KRTX-1721). A trigger the hourly limit holds after it
 * ran at that limit through the previous hour pauses itself: every automatic
 * fire is skipped with the reason until someone resumes it with
 * `enabled: true`. For 2 hours after a resume it cannot pause itself again.
 * Local only: the runs inside the two windows are seeded in the database.
 */
flow(
  'TRG-38',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'POST /v1/webhooks/projects/:projectId/:slug',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return;
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const slugParams = { ...params, slug: 'runaway' };
    const secret = `ke2e-runaway-${crypto.randomUUID()}`;
    const paused = 'auto-paused: ran at max_runs_per_hour 1 for 2 hours in a row';
    const listed = async () => {
      const t = (await owner.get('/v1/projects/:projectId/triggers', { params })).status(200)
        .json<{ triggers: Array<{ slug: string; enabled: boolean; auto_paused_at?: string | null; auto_paused_reason?: string | null }> }>()
        .triggers.find((row) => row.slug === 'runaway');
      if (!t) throw new Error('runaway is not listed');
      return t;
    };
    const deliver = async () => {
      const rawBody = JSON.stringify({ action: 'opened' });
      return ctx.client.as(ctx.P.ANON).post('/v1/webhooks/projects/:projectId/:slug', rawBody, {
        params: slugParams,
        raw: true,
        headers: {
          'content-type': 'application/json',
          'x-kortix-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
          'x-kortix-delivery-id': crypto.randomUUID(),
        },
      });
    };

    await ctx.step('a webhook trigger with max_runs_per_hour 1 → 201; it is not auto-paused', async () => {
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'HOOK_SECRET', value: secret, strategy: 'broker', consumer: 'connector' }, { params })).status(200);
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'runaway', slug: 'runaway', type: 'webhook', secret_env: 'HOOK_SECRET', prompt_template: 'Run {{ body.action }}', max_runs_per_hour: 1 }, { params })).status(201);
      const t = await listed();
      if (t.auto_paused_at !== null || t.auto_paused_reason !== null) throw new Error(`expected auto_paused_at: null and auto_paused_reason: null, got ${JSON.stringify({ auto_paused_at: t.auto_paused_at, auto_paused_reason: t.auto_paused_reason })}`);
    });

    await ctx.step('with a run 90 minutes ago and one 5 minutes ago, a signed delivery → 200 skipped "auto-paused: …", and the listing carries the pause', async () => {
      await withDb(ctx, (db) =>
        db.query(
          `INSERT INTO kortix.project_trigger_executions (project_id, slug, schedule_revision, scheduled_for, status, spec, payload, source, created_at)
           VALUES ($1, 'runaway', 'webhook:' || gen_random_uuid(), now(), 'succeeded', '{}'::jsonb, '{"body":{}}'::jsonb, 'webhook', now() - interval '90 minutes'),
                  ($1, 'runaway', 'webhook:' || gen_random_uuid(), now(), 'succeeded', '{}'::jsonb, '{"body":{}}'::jsonb, 'webhook', now() - interval '5 minutes')`,
          [p.id],
        ),
      );
      (await deliver()).status(200).body().has('$.status', 'skipped').has('$.reason', paused);
      const t = await listed();
      if (!t.auto_paused_at || t.auto_paused_reason !== paused || t.enabled !== true) throw new Error(`listing after the pause: ${JSON.stringify(t)}`);
    });

    await ctx.step('while auto-paused another delivery is skipped with the same reason; a manual fire still reaches the fire path (402 locally)', async () => {
      (await deliver()).status(200).body().has('$.status', 'skipped').has('$.reason', paused);
      (await owner.post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: slugParams })).status(402);
    });

    await ctx.step('CLI: `kortix triggers ls` marks it auto-paused; `kortix triggers info runaway` prints the reason and the resume command', async () => {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-trg38') });
      const sb = new CliSandbox('trg38');
      try {
        const login = await sb.login(pat, { noProject: true, account: ctx.P.accountId });
        if (login.exitCode !== 0) throw new Error(`login failed: ${login.all}`);
        const ls = await sb.run(['triggers', 'ls', '--project', p.id]);
        throwIfCliInfraFailure(ls, 'triggers ls');
        if (ls.exitCode !== 0 || !/runaway[\s\S]*auto-paused/.test(ls.stdout)) throw new Error(`ls: exit ${ls.exitCode}: ${ls.all}`);
        const info = await sb.run(['triggers', 'info', 'runaway', '--project', p.id]);
        if (info.exitCode !== 0 || !info.stdout.includes(paused) || !info.stdout.includes('kortix triggers enable runaway --apply')) {
          throw new Error(`info: exit ${info.exitCode}: ${info.all}`);
        }
      } finally {
        sb.dispose();
      }
    });

    await ctx.step('PATCH { enabled: true } resumes it; for 2 hours a held delivery is a plain throttle, not a new pause', async () => {
      (await owner.patch('/v1/projects/:projectId/triggers/:slug', { enabled: true }, { params: slugParams })).status(200);
      const resumed = await listed();
      if (resumed.auto_paused_at !== null || resumed.auto_paused_reason !== null) throw new Error(`still auto-paused after resume: ${JSON.stringify(resumed)}`);
      (await deliver()).status(200).body().has('$.status', 'skipped').has('$.reason', 'throttled: 1 runs in the last hour (max_runs_per_hour 1)');
      if ((await listed()).auto_paused_at !== null) throw new Error('a held delivery right after the resume paused it again');
    });
  },
);

/**
 * TRG-39 — overlap (KRTX-1721). A fresh-mode trigger with `overlap: skip` starts
 * nothing while its previous run is still active (a session it created is
 * still being set up or running a turn). `skip` is the cron default, `allow`
 * the default for the other types. Local only: the active session is seeded.
 */
flow(
  'TRG-39',
  {
    domain: 'triggers',
    routes: [
      'POST /v1/projects/:projectId/secrets',
      'POST /v1/projects/:projectId/triggers',
      'GET /v1/projects/:projectId/triggers',
      'PATCH /v1/projects/:projectId/triggers/:slug',
      'POST /v1/webhooks/projects/:projectId/:slug',
      'GET /v1/projects/:projectId/triggers/:slug/runs',
      'POST /v1/projects/:projectId/triggers/:slug/fire',
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== 'local') return;
    const p = await ctx.fixtures.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };
    const slugParams = { ...params, slug: 'one-at-a-time' };
    const secret = `ke2e-overlap-${crypto.randomUUID()}`;
    const overlapOf = async (slug: string) => {
      const t = (await owner.get('/v1/projects/:projectId/triggers', { params })).status(200)
        .json<{ triggers: Array<{ slug: string; overlap?: string | null }> }>().triggers.find((row) => row.slug === slug);
      if (!t) throw new Error(`${slug} is not listed`);
      return t.overlap;
    };
    const deliver = async () => {
      const rawBody = JSON.stringify({ action: 'opened' });
      return ctx.client.as(ctx.P.ANON).post('/v1/webhooks/projects/:projectId/:slug', rawBody, {
        params: slugParams,
        raw: true,
        headers: {
          'content-type': 'application/json',
          'x-kortix-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
          'x-kortix-delivery-id': crypto.randomUUID(),
        },
      });
    };

    await ctx.step('overlap other than skip or allow → 400; a cron trigger without it lists null (the skip default applies)', async () => {
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'Bad', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'x', overlap: 'queue' }, { params }))
        .status(400).body().has('$.error', 'overlap must be "skip" or "allow"');
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'Nightly', slug: 'nightly', type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC', prompt_template: 'x' }, { params })).status(201);
      const listed = await overlapOf('nightly');
      if (listed !== null) throw new Error(`nightly overlap: ${JSON.stringify(listed)}, expected null`);
    });

    await ctx.step('a webhook trigger with overlap: skip → 201 and lists skip; a PATCH of only overlap writes it', async () => {
      (await owner.post('/v1/projects/:projectId/secrets', { name: 'HOOK_SECRET', value: secret, strategy: 'broker', consumer: 'connector' }, { params })).status(200);
      (await owner.post('/v1/projects/:projectId/triggers', { name: 'one-at-a-time', slug: 'one-at-a-time', type: 'webhook', secret_env: 'HOOK_SECRET', prompt_template: 'Run {{ body.action }}', overlap: 'skip' }, { params })).status(201);
      if ((await overlapOf('one-at-a-time')) !== 'skip') throw new Error('one-at-a-time does not list overlap skip');
      (await owner.patch('/v1/projects/:projectId/triggers/:slug', { overlap: 'allow' }, { params: { ...params, slug: 'nightly' } })).status(200);
      if ((await overlapOf('nightly')) !== 'allow') throw new Error('a PATCH of only overlap did not write it');
    });

    await ctx.step('with a session of this trigger still being set up, a signed delivery → 200 skipped "overlap: …", a skipped run, no new session', async () => {
      const sessionId = crypto.randomUUID();
      await withDb(ctx, (db) =>
        db.query(
          `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, created_by, status, metadata)
           SELECT $1, account_id, project_id, $2, $3, 'provisioning', '{"trigger_slug":"one-at-a-time","trigger_kind":"git"}'::jsonb
             FROM kortix.projects WHERE project_id = $4`,
          [sessionId, `session/${sessionId}`, ctx.P.OWNER.userId!, p.id],
        ),
      );
      const reason = `overlap: the previous run is still active (session ${sessionId})`;
      (await deliver()).status(200).body().has('$.status', 'skipped').has('$.reason', reason);
      const runs = (await owner.get('/v1/projects/:projectId/triggers/:slug/runs', { params: slugParams })).status(200).json<RunList>().runs;
      if (!runs.some((run) => run.status === 'skipped' && run.error === reason && run.session_id === null)) throw new Error(`no skipped overlap run: ${JSON.stringify(runs)}`);
      const sessions = await withDb(ctx, async (db) =>
        Number((await db.query(`SELECT count(*) AS n FROM kortix.project_sessions WHERE project_id = $1 AND metadata->>'trigger_slug' = 'one-at-a-time'`, [p.id])).rows[0]?.n ?? 0),
      );
      if (sessions !== 1) throw new Error(`a held delivery created a session: ${sessions} sessions`);
    });

    await ctx.step('a manual fire is not held: it reaches the fire path (402 locally)', async () => {
      (await owner.post('/v1/projects/:projectId/triggers/:slug/fire', {}, { params: slugParams })).status(402);
    });

    await ctx.step('CLI: `--overlap default` resets it, info prints the effective value, `--overlap queue` exits 2', async () => {
      const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('cli-trg39') });
      const sb = new CliSandbox('trg39');
      try {
        const login = await sb.login(pat, { noProject: true, account: ctx.P.accountId });
        if (login.exitCode !== 0) throw new Error(`login failed: ${login.all}`);
        const reset = await sb.run(['triggers', 'set', 'one-at-a-time', '--overlap', 'default', '--project', p.id]);
        throwIfCliInfraFailure(reset, 'triggers set');
        if (reset.exitCode !== 0) throw new Error(`set --overlap default: exit ${reset.exitCode}: ${reset.all}`);
        if ((await overlapOf('one-at-a-time')) !== null) throw new Error('--overlap default did not reset it');
        const info = await sb.run(['triggers', 'info', 'one-at-a-time', '--project', p.id]);
        if (info.exitCode !== 0 || !/overlap\s+allow \(default\)/.test(info.stdout)) throw new Error(`info: exit ${info.exitCode}: ${info.all}`);
        const bad = await sb.run(['triggers', 'set', 'one-at-a-time', '--overlap', 'queue', '--project', p.id]);
        if (bad.exitCode !== 2 || !bad.stderr.includes('--overlap must be skip or allow, or default to reset it (got "queue").')) {
          throw new Error(`set --overlap queue: exit ${bad.exitCode}: ${bad.all}`);
        }
      } finally {
        sb.dispose();
      }
    });
  },
);
