/**
 * Session reminders — scheduled prompts into one session, stored in the
 * database (not kortix.yaml). Spec: tests/spec/end-to-end.md § Reminders.
 * Source of truth: apps/api/src/projects/routes/session-reminders.ts +
 * projects/lib/session-reminders.ts.
 *
 * The local profile runs no trigger scheduler (KORTIX_TRIGGER_SCHEDULER_ENABLED
 * =false) and no sandboxes, so a FIRE is covered by
 * apps/api/src/__tests__/integration-session-reminders.test.ts. These flows pin
 * the HTTP and CLI contract.
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { CliSandbox } from '../fixtures/cli';

const ROUTES = {
  list: 'GET /v1/projects/:projectId/sessions/:sessionId/reminders',
  create: 'POST /v1/projects/:projectId/sessions/:sessionId/reminders',
  update: 'PATCH /v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId',
  remove: 'DELETE /v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId',
};
const REMINDERS = '/v1/projects/:projectId/sessions/:sessionId/reminders';
const REMINDER = '/v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId';
const MANIFEST =
  'kortix_version: 2\nproject:\n  name: ke2e-reminders\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n';

type Reminder = { id: string; state: string; every: string | null; next_fire_at: string | null; prompt: string };

async function openWorld(ctx: FlowContext) {
  const team = await ctx.fixtures.team();
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  await world.setFeature('reminders', true);
  await world.writeManifest(MANIFEST, 'ke2e: reminders agent');
  return { team, project, world };
}

flow(
  'REM-1',
  {
    domain: 'reminders',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [...Object.values(ROUTES), 'POST /v1/projects/:projectId/triggers', 'GET /v1/projects/:projectId/triggers'],
  },
  async (ctx) => {
    const { team, project, world } = await openWorld(ctx);
    const owner = ctx.client.as(ctx.P.OWNER);
    try {
      const session = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER });
      const params = { projectId: project.id, sessionId: session.sessionId };
      let id = '';

      await ctx.step('the owner sets "in 24h, then every 1h" on their session → 201 active, first fire ~24h out', async () => {
        const before = Date.now();
        const r = await owner.post(REMINDERS, { prompt: 'Did the email arrive?', in: '24h', every: '1h' }, { params });
        r.status(201).body().has('$.state', 'active').has('$.every', '1h').has('$.session_id', session.sessionId).has('$.prompt', 'Did the email arrive?');
        const body = r.json<Reminder>();
        if (!/^reminder\.[0-9a-f]{12}$/.test(body.id)) throw new Error(`unexpected id ${body.id}`);
        const next = Date.parse(body.next_fire_at ?? '');
        if (Math.abs(next - (before + 24 * 3600_000)) > 60_000) throw new Error(`next_fire_at ${body.next_fire_at} is not ~24h out`);
        id = body.id;
      });

      await ctx.step('the list reads it back', async () => {
        (await owner.get(REMINDERS, { params })).status(200).body().has('$.reminders[0].id', id);
      });

      await ctx.step('bad schedules → 400 with the reason, nothing stored', async () => {
        for (const [body, reason] of [
          [{ prompt: 'x', every: '1m' }, 'every must be at least 5m'],
          [{ prompt: 'x' }, 'Say when the reminder fires'],
          [{ prompt: 'x', at: '2020-01-01T00:00:00Z' }, 'at must be in the future'],
          [{ every: '1h' }, 'prompt is required'],
          [{ prompt: 'x', in: '99999999999d' }, 'in must be at most 366d'],
          [{ prompt: 'x', in: 1e30 }, 'in must be at most 366d'],
          [{ prompt: 'x', at: '9999-12-31T00:00:00Z' }, 'must be at most 366d from now'],
          [{ prompt: 'x', in: '1h', every: '99999999999d' }, 'every must be at most 366d'],
        ] as const) {
          const r = await owner.post(REMINDERS, body, { params });
          r.status(400);
          if (!r.text().includes(reason)) throw new Error(`expected "${reason}", got ${r.text()}`);
        }
        const listed = (await owner.get(REMINDERS, { params })).json<{ reminders: Reminder[] }>().reminders;
        if (listed.length !== 1) throw new Error(`expected 1 reminder, got ${listed.length}`);
      });

      await ctx.step('pause clears next_fire_at; resume re-arms it one period from now', async () => {
        (await owner.patch(REMINDER, { enabled: false }, { params: { ...params, reminderId: id } }))
          .status(200).body().has('$.state', 'paused').has('$.next_fire_at', null);
        const r = await owner.patch(REMINDER, { enabled: true }, { params: { ...params, reminderId: id } });
        r.status(200).body().has('$.state', 'active');
        const next = Date.parse(r.json<Reminder>().next_fire_at ?? '');
        if (Math.abs(next - (Date.now() + 3600_000)) > 60_000) throw new Error('resume did not re-arm one period out');
      });

      await ctx.step('a kortix.yaml trigger write reconciles the catalog and the reminder survives; /triggers never lists it', async () => {
        (await owner.post('/v1/projects/:projectId/triggers', {
          name: 'Nightly', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'nightly',
        }, { params: { projectId: project.id }, timeoutMs: 60_000 })).status(201);
        (await owner.get(REMINDERS, { params })).status(200).body().has('$.reminders[0].id', id);
        const triggers = (await owner.get('/v1/projects/:projectId/triggers', { params: { projectId: project.id } })).text();
        if (triggers.includes(id)) throw new Error('GET /triggers lists a reminder');
      });

      await ctx.step('an anonymous caller → 401; a member who cannot see the private session → 404', async () => {
        (await ctx.client.as(ctx.P.ANON).get(REMINDERS, { params })).status(401);
        const member = await team.addMember('member');
        await team.grantProjectRole(project.id, member.userId!, 'member');
        await world.grantRun('kortix', member);
        (await ctx.client.as(member).post(REMINDERS, { prompt: 'x', in: '1h' }, { params })).status(404);
      });

      await ctx.step('delete → 200 and gone; deleting again → 404', async () => {
        (await owner.del(REMINDER, { params: { ...params, reminderId: id } })).status(200).body().has('$.ok', true);
        (await owner.get(REMINDERS, { params })).status(200).body().has('$.reminders', []);
        (await owner.del(REMINDER, { params: { ...params, reminderId: id } })).status(404);
      });

      await ctx.step('a deleted session refuses new reminders → 409', async () => {
        await world.db.query(
          `UPDATE kortix.project_sessions SET metadata = metadata || jsonb_build_object('deletedAt', now()::text) WHERE session_id = $1`,
          [session.sessionId],
        );
        (await owner.post(REMINDERS, { prompt: 'x', in: '1h' }, { params })).status(409);
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  'REM-2',
  {
    domain: 'reminders',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: Object.values(ROUTES),
  },
  async (ctx) => {
    const { team, project, world } = await openWorld(ctx);
    const sandbox = new CliSandbox('rem2');
    try {
      const own = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER });
      const other = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER });
      const params = { projectId: project.id, sessionId: own.sessionId };

      await ctx.step('an agent session credential sets a reminder on its OWN session → 201; on_behalf_of stays the launcher', async () => {
        (await own.client.post(REMINDERS, { prompt: 'Recheck the deploy', every: '30m' }, { params })).status(201).body().has('$.every', '30m');
        if (own.onBehalfOfColumn && (await world.readOnBehalfOf(own.sessionId)) !== ctx.P.OWNER.userId) {
          throw new Error('an agent-created reminder cleared on_behalf_of');
        }
      });

      await ctx.step('the same credential on a private sibling session it cannot open → 404, nothing stored there', async () => {
        const sibling = { projectId: project.id, sessionId: other.sessionId };
        (await own.client.post(REMINDERS, { prompt: 'x', in: '1h' }, { params: sibling })).status(404);
        (await own.client.get(REMINDERS, { params: sibling })).status(404);
        (await ctx.client.as(ctx.P.OWNER).get(REMINDERS, { params: sibling })).status(200).body().has('$.reminders', []);
      });

      await ctx.step('real CLI inside the session: `kortix remind … --in 2h --json` exits 0 and the API reads it back', async () => {
        const env = {
          KORTIX_TOKEN: own.secret,
          KORTIX_API_URL: ctx.env.apiUrl,
          KORTIX_PROJECT_ID: project.id,
          KORTIX_SESSION_ID: own.sessionId,
        };
        const created = await sandbox.run(['remind', 'Did the vendor email arrive?', '--in', '2h', '--json'], { env });
        if (created.exitCode !== 0) throw new Error(`remind exit ${created.exitCode}: ${created.all.slice(0, 600)}`);
        const reminder = JSON.parse(created.stdout.trim()) as Reminder;
        if (reminder.state !== 'active' || reminder.every !== null) throw new Error(`unexpected ${created.stdout}`);
        const listed = await sandbox.run(['reminders', 'ls', '--json'], { env });
        if (!listed.stdout.includes(reminder.id)) throw new Error(`ls lacks ${reminder.id}: ${listed.all.slice(0, 600)}`);
        const removed = await sandbox.run(['reminders', 'rm', reminder.id], { env });
        if (removed.exitCode !== 0) throw new Error(`rm exit ${removed.exitCode}: ${removed.all.slice(0, 600)}`);
        const after = (await own.client.get(REMINDERS, { params })).json<{ reminders: Reminder[] }>().reminders;
        if (after.some((r) => r.id === reminder.id)) throw new Error('rm did not delete the reminder');
      });

      await ctx.step('another human setting a reminder on a shared session → 201; on_behalf_of stays the launcher until the fire is delivered', async () => {
        const shared = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER, visibility: 'project' });
        const member = await team.addMember('member');
        await team.grantProjectRole(project.id, member.userId!, 'member');
        await world.grantRun('kortix', member);
        (await ctx.client.as(member).post(REMINDERS, { prompt: 'x', in: '1h' }, {
          params: { projectId: project.id, sessionId: shared.sessionId },
        })).status(201);
        // The reminder is this member's deferred prompt: its delivery binds the
        // turn to them (trigger-fire.ts). Creating it must not touch the
        // launcher's running turn.
        if (shared.onBehalfOfColumn && (await world.readOnBehalfOf(shared.sessionId)) !== ctx.P.OWNER.userId) {
          throw new Error('creating a reminder changed on_behalf_of before the reminder fired');
        }
      });
    } finally {
      sandbox.dispose();
      await world.close();
    }
  },
);

flow(
  'REM-3',
  {
    domain: 'reminders',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: ['GET /v1/projects/:projectId/reminders', ROUTES.create],
  },
  async (ctx) => {
    const { team, project, world } = await openWorld(ctx);
    const owner = ctx.client.as(ctx.P.OWNER);
    const PROJECT_REMINDERS = '/v1/projects/:projectId/reminders';
    try {
      const mine = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER });
      const shared = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER, visibility: 'project' });
      await world.db.query(
        `UPDATE kortix.project_sessions SET metadata = metadata || '{"custom_name":"Vendor follow-up"}'::jsonb WHERE session_id = $1`,
        [mine.sessionId],
      );
      const set = async (sessionId: string, body: Record<string, unknown>) => {
        const r = await owner.post(REMINDERS, body, { params: { projectId: project.id, sessionId } });
        r.status(201);
        return r.json<Reminder>().id;
      };
      let later = '';
      let sooner = '';
      let onShared = '';

      await ctx.step('the owner lists reminders across sessions, soonest first, each with its session name', async () => {
        later = await set(mine.sessionId, { prompt: 'Check again tomorrow', in: '24h' });
        sooner = await set(mine.sessionId, { prompt: 'Check in an hour', in: '1h', every: '1h' });
        onShared = await set(shared.sessionId, { prompt: 'Shared check', in: '2h' });
        const r = await owner.get(PROJECT_REMINDERS, { params: { projectId: project.id } });
        r.status(200);
        const ids = r.json<{ reminders: Array<{ id: string }> }>().reminders.map((x) => x.id);
        if (ids.join(',') !== [sooner, onShared, later].join(',')) throw new Error(`order ${ids.join(',')}`);
        r.body().has('$.reminders[0].session_name', 'Vendor follow-up').has('$.reminders[0].session_id', mine.sessionId);
      });

      await ctx.step('a paused reminder sorts after every active one', async () => {
        (await owner.patch(REMINDER, { enabled: false }, { params: { projectId: project.id, sessionId: mine.sessionId, reminderId: sooner } })).status(200);
        const ids = (await owner.get(PROJECT_REMINDERS, { params: { projectId: project.id } }))
          .json<{ reminders: Array<{ id: string }> }>().reminders.map((x) => x.id);
        if (ids.join(',') !== [onShared, later, sooner].join(',')) throw new Error(`order ${ids.join(',')}`);
      });

      await ctx.step('a member sees only reminders on sessions they can open (the project-visible one), never the private ones', async () => {
        const member = await team.addMember('member');
        await team.grantProjectRole(project.id, member.userId!, 'member');
        const r = await ctx.client.as(member).get(PROJECT_REMINDERS, { params: { projectId: project.id } });
        r.status(200);
        const ids = r.json<{ reminders: Array<{ id: string }> }>().reminders.map((x) => x.id);
        if (ids.join(',') !== onShared) throw new Error(`member saw ${ids.join(',')}`);
      });

      await ctx.step('an agent credential sees what it may open: its own session and project-visible siblings, never a private sibling; ANON → 401', async () => {
        const privateSibling = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER });
        const hidden = await set(privateSibling.sessionId, { prompt: 'Private sibling check', in: '3h' });
        const seen = (await mine.client.get(PROJECT_REMINDERS, { params: { projectId: project.id } }))
          .json<{ reminders: Array<{ id: string; session_id: string }> }>().reminders;
        const sessions = new Set(seen.map((x) => x.session_id));
        if (seen.some((x) => x.id === hidden)) throw new Error('agent saw a private sibling session reminder');
        if (!sessions.has(mine.sessionId) || !sessions.has(shared.sessionId) || sessions.size !== 2) {
          throw new Error(`agent saw sessions ${[...sessions].join(',')}`);
        }
        (await ctx.client.as(ctx.P.ANON).get(PROJECT_REMINDERS, { params: { projectId: project.id } })).status(401);
      });

      await ctx.step('a deleted session drops out of the list', async () => {
        await world.db.query(
          `UPDATE kortix.project_sessions SET metadata = metadata || jsonb_build_object('deletedAt', now()::text) WHERE session_id = $1`,
          [shared.sessionId],
        );
        const ids = (await owner.get(PROJECT_REMINDERS, { params: { projectId: project.id } }))
          .json<{ reminders: Array<{ id: string }> }>().reminders.map((x) => x.id);
        if (ids.includes(onShared)) throw new Error('deleted session still listed');
      });
    } finally {
      await world.close();
    }
  },
);

flow(
  'REM-4',
  {
    domain: 'reminders',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      ROUTES.list,
      ROUTES.create,
      ROUTES.update,
      ROUTES.remove,
      'GET /v1/projects/:projectId/reminders',
      'PATCH /v1/projects/:projectId/features',
    ],
  },
  async (ctx) => {
    const { project, world } = await openWorld(ctx);
    const owner = ctx.client.as(ctx.P.OWNER);
    try {
      const session = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER });
      const params = { projectId: project.id, sessionId: session.sessionId };
      let id = '';
      await ctx.step('with the flag on, a reminder is created', async () => {
        const r = await owner.post(REMINDERS, { prompt: 'Check later', in: '1h' }, { params });
        r.status(201);
        id = r.json<Reminder>().id;
      });

      await ctx.step('flag off: every reminder route answers 403 feature_disabled for the owner and the agent', async () => {
        await world.setFeature('reminders', false);
        const denied = [
          await owner.get(REMINDERS, { params }),
          await owner.post(REMINDERS, { prompt: 'x', in: '1h' }, { params }),
          await owner.patch(REMINDER, { enabled: false }, { params: { ...params, reminderId: id } }),
          await owner.del(REMINDER, { params: { ...params, reminderId: id } }),
          await owner.get('/v1/projects/:projectId/reminders', { params: { projectId: project.id } }),
          await session.client.post(REMINDERS, { prompt: 'x', in: '1h' }, { params }),
        ];
        for (const r of denied) r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'reminders');
      });

      await ctx.step('flag back on: the reminder created before is still there and active', async () => {
        await world.setFeature('reminders', true);
        (await owner.get(REMINDERS, { params })).status(200).body().has('$.reminders[0].id', id).has('$.reminders[0].state', 'active');
      });
    } finally {
      await world.close();
    }
  },
);
