/**
 * Triggers — one list for kortix.yaml triggers and runtime triggers (loops and
 * `POST /triggers/runtime` rows). Spec: tests/spec/end-to-end.md § 12c.
 * Source of truth: apps/api/src/projects/routes/runtime-triggers.ts +
 * projects/lib/runtime-triggers.ts.
 *
 * The local profile runs no scheduler and no sandboxes: a FIRE (webhook into a
 * session, a merged change request, a kortix.yaml change_request trigger) is
 * proved in apps/api/src/__tests__/integration-runtime-triggers.test.ts. This
 * flow pins the HTTP and CLI contract.
 */
import { flow } from '../core/flow';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { CliSandbox } from '../fixtures/cli';

const ROUTES = {
  list: 'GET /v1/projects/:projectId/triggers/all',
  create: 'POST /v1/projects/:projectId/triggers/runtime',
  update: 'PATCH /v1/projects/:projectId/triggers/runtime/:id',
  remove: 'DELETE /v1/projects/:projectId/triggers/runtime/:id',
  run: 'POST /v1/projects/:projectId/triggers/runtime/:id/run',
};
const ALL = '/v1/projects/:projectId/triggers/all';
const RUNTIME = '/v1/projects/:projectId/triggers/runtime';
const ONE = '/v1/projects/:projectId/triggers/runtime/:id';
const MANIFEST =
  'project:\n  name: ke2e-runtime-triggers\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n';

type TriggerRow = {
  id: string;
  origin: 'declared' | 'runtime';
  state: string;
  next_fire_at: string | null;
  source: { type: string; webhook_url?: string };
  target: { kind: string; session_id?: string; agent?: string };
};

flow(
  'TRG-41',
  {
    domain: 'triggers',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      ROUTES.list,
      ROUTES.create,
      ROUTES.update,
      ROUTES.remove,
      ROUTES.run,
      'POST /v1/projects/:projectId/triggers',
      'POST /v1/projects/:projectId/sessions/:sessionId/reminders',
      'POST /v1/projects/:projectId/secrets',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
    const sandbox = new CliSandbox('trg41');
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id };
    try {
      await world.setFeature('reminders', true);
      await world.writeManifest(MANIFEST, 'ke2e: runtime triggers agent');
      const session = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER });
      let loopId = '';

      await ctx.step('a kortix.yaml trigger and a reminder list together, each with its origin, source and target', async () => {
        (await owner.post('/v1/projects/:projectId/triggers', {
          name: 'Nightly', slug: 'nightly', type: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', prompt_template: 'nightly',
        }, { params, timeoutMs: 60_000 })).status(201);
        const loop = await owner.post('/v1/projects/:projectId/sessions/:sessionId/reminders', { prompt: 'Check', every: '1h' }, {
          params: { ...params, sessionId: session.sessionId },
        });
        loop.status(201);
        loopId = loop.json<{ id: string }>().id;
        const rows = (await owner.get(ALL, { params })).status(200).json<{ triggers: TriggerRow[] }>().triggers;
        const declared = rows.find((a) => a.id === 'nightly');
        const runtime = rows.find((a) => a.id === loopId);
        if (declared?.origin !== 'declared' || declared.source.type !== 'schedule' || declared.target.kind !== 'agent') {
          throw new Error(`declared row wrong: ${JSON.stringify(declared)}`);
        }
        if (runtime?.origin !== 'runtime' || runtime.target.kind !== 'session' || runtime.target.session_id !== session.sessionId) {
          throw new Error(`runtime row wrong: ${JSON.stringify(runtime)}`);
        }
      });

      let crId = '';
      await ctx.step('a merged-change-request trigger into the session → 201 active, no next fire', async () => {
        const r = await owner.post(RUNTIME, {
          prompt: 'CR #{{ change_request.number }} merged: verify it',
          source: { type: 'change_request' },
          target: { session_id: session.sessionId },
        }, { params });
        r.status(201).body().has('$.state', 'active').has('$.next_fire_at', null).has('$.origin', 'runtime').has('$.target.kind', 'session');
        crId = r.json<TriggerRow>().id;
        if (!/^trigger\.[0-9a-f]{12}$/.test(crId)) throw new Error(`unexpected id ${crId}`);
      });

      await ctx.step('a runtime webhook trigger that starts an agent → 201 with its webhook URL', async () => {
        (await owner.post('/v1/projects/:projectId/secrets', { name: 'TRG41_HOOK_SECRET', value: 'auto-hook-secret-value-0123456789', strategy: 'broker', consumer: 'connector' }, { params })).status(200);
        const r = await owner.post(RUNTIME, {
          prompt: 'Triage {{ body.title }}',
          source: { type: 'webhook', secret_env: 'TRG41_HOOK_SECRET' },
          target: { agent: 'kortix' },
        }, { params });
        r.status(201).body().has('$.target.kind', 'agent').has('$.source.type', 'webhook');
        const created = r.json<TriggerRow>();
        if (!created.source.webhook_url?.endsWith(`/v1/webhooks/projects/${project.id}/${created.id}`)) {
          throw new Error(`webhook_url wrong: ${created.source.webhook_url}`);
        }
      });

      await ctx.step('no target, or an unknown source type → 400; nothing stored', async () => {
        const before = (await owner.get(ALL, { params })).json<{ triggers: TriggerRow[] }>().triggers.length;
        (await owner.post(RUNTIME, { prompt: 'x', source: { type: 'webhook', secret_env: 'S' } }, { params })).status(400);
        (await owner.post(RUNTIME, { prompt: 'x', source: { type: 'email' }, target: { agent: 'kortix' } }, { params })).status(400);
        const after = (await owner.get(ALL, { params })).json<{ triggers: TriggerRow[] }>().triggers.length;
        if (after !== before) throw new Error(`a refused create stored a row (${before} → ${after})`);
      });

      await ctx.step('run now → 202: the session-target trigger queues its prompt into the session', async () => {
        (await owner.post(`${ONE}/run`, {}, { params: { ...params, id: crId } })).status(202).body().has('$.id', crId);
      });

      await ctx.step('pause → paused; a kortix.yaml slug is not a runtime id → 404', async () => {
        (await owner.patch(ONE, { enabled: false }, { params: { ...params, id: crId } })).status(200).body().has('$.state', 'paused');
        (await owner.patch(ONE, { enabled: false }, { params: { ...params, id: 'nightly' } })).status(404);
      });

      await ctx.step('the real CLI lists the runtime rows: `kortix triggers ls --json` → `runtime`', async () => {
        const listed = await sandbox.run(['triggers', 'ls', '--json'], {
          env: { KORTIX_TOKEN: session.secret, KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: project.id, KORTIX_SESSION_ID: session.sessionId },
        });
        if (listed.exitCode !== 0) throw new Error(`ls exit ${listed.exitCode}: ${listed.all.slice(0, 600)}`);
        if (!listed.stdout.includes(loopId) || !listed.stdout.includes(crId)) throw new Error(`ls lacks a row: ${listed.stdout.slice(0, 600)}`);
      });

      await ctx.step('delete → 200 and gone; ANON → 401', async () => {
        (await owner.del(ONE, { params: { ...params, id: crId } })).status(200).body().has('$.ok', true);
        const rows = (await owner.get(ALL, { params })).json<{ triggers: TriggerRow[] }>().triggers;
        if (rows.some((a) => a.id === crId)) throw new Error('delete did not remove the runtime trigger');
        (await ctx.client.as(ctx.P.ANON).get(ALL, { params })).status(401);
      });
    } finally {
      await world.close();
    }
  },
);
