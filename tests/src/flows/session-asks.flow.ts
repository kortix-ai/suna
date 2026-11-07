import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { openFlowDb, seedTurnSession } from '../fixtures/turn-end';

/** sha256 hex the daemon sends for a call (`permissionArgsHash`): any 64 hex digits name one call. */
const PUSH_HASH = 'b'.repeat(64);
const asksRoute = '/v1/workspaces/:projectId/asks';
const answerRoute = '/v1/workspaces/:projectId/asks/:askId/answer';

interface Ask {
  id: string;
  kind: string;
  session_id: string;
  surface_session_id: string;
  request_id: string;
  title: string;
}

async function team(ctx: FlowContext) {
  const t = await ctx.fixtures.team();
  const project = await t.project();
  const launcher = await t.addMember('member');
  const other = await t.addMember('member');
  await t.grantProjectRole(project.id, launcher.userId!, 'member');
  await t.grantProjectRole(project.id, other.userId!, 'member');
  return { team: t, project, launcher, other };
}

flow(
  'SESS-63',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/workspaces/:projectId/turn-permission',
      'POST /v1/workspaces/:projectId/turn-question',
      'GET /v1/workspaces/:projectId/asks',
      'POST /v1/workspaces/:projectId/asks/:askId/answer',
    ],
  },
  async (ctx) => {
    const { team: t, project, launcher, other } = await team(ctx);
    const db = await openFlowDb(ctx.env);
    const watched = await seedTurnSession(ctx, db, { projectId: project.id, accountId: t.id, creator: launcher });
    const unattended = await seedTurnSession(ctx, db, {
      projectId: project.id,
      accountId: t.id,
      creator: launcher,
      metadata: { source: 'trigger:nightly' },
    });
    const params = { projectId: project.id };
    const relayPermission = (requestId: string, session = watched) =>
      session.sandbox.post(
        '/v1/workspaces/:projectId/turn-permission',
        {
          session_id: session.sessionId,
          request_id: requestId,
          runtime_session_id: 'ses_root',
          permission: 'bash',
          patterns: ['git push origin main'],
          tool: 'bash',
          args_hash: PUSH_HASH,
          args: { command: 'git push origin main' },
        },
        { params },
      );
    const asksOf = async (who: typeof launcher, query: Record<string, string> = {}) => {
      const r = await ctx.client.as(who).get(asksRoute, { params, query });
      r.status(200);
      return r.json<{ asks: Ask[] }>().asks;
    };
    let permissionAskId = '';
    try {
      await ctx.step('the sandbox relays a permission ask → 200 with a live window; a retry stores nothing new', async () => {
        (await relayPermission('perm_sess63')).status(200).body().has('$.live_wait_ms', 180_000);
        (await relayPermission('perm_sess63')).status(200).body().has('$.notified', false);
      });

      await ctx.step('the launcher lists it once, titled with the command, on its own session; another member lists nothing', async () => {
        const asks = (await asksOf(launcher)).filter((a) => a.session_id === watched.sessionId);
        if (asks.length !== 1) throw new Error(`expected one ask, got ${JSON.stringify(asks)}`);
        const [ask] = asks;
        if (ask!.kind !== 'permission' || ask!.title !== 'bash: git push origin main' || ask!.surface_session_id !== watched.sessionId) {
          throw new Error(JSON.stringify(ask));
        }
        permissionAskId = ask!.id;
        const onSession = await asksOf(launcher, { surface_session_id: watched.sessionId });
        if (onSession.map((a) => a.id).join() !== permissionAskId) throw new Error(JSON.stringify(onSession));
        if ((await asksOf(other)).some((a) => a.id === permissionAskId)) throw new Error('another member sees the ask');
      });

      await ctx.step('the agent cannot decide its own ask (403); another member cannot (403); a bad reply is 400', async () => {
        (await watched.sandbox.post(answerRoute, { reply: 'once' }, { params: { ...params, askId: permissionAskId } }))
          .status(403);
        (await ctx.client.as(other).post(answerRoute, { reply: 'once' }, { params: { ...params, askId: permissionAskId } }))
          .status(403);
        (await ctx.client.as(launcher).post(answerRoute, { reply: 'sometimes' }, { params: { ...params, askId: permissionAskId } }))
          .status(400);
      });

      await ctx.step('the launcher approves it once → 200; a second decision → 409; it leaves the list', async () => {
        (await ctx.client.as(launcher).post(answerRoute, { reply: 'once' }, { params: { ...params, askId: permissionAskId } }))
          .status(200);
        (await ctx.client.as(launcher).post(answerRoute, { reply: 'reject' }, { params: { ...params, askId: permissionAskId } }))
          .status(409);
        if ((await asksOf(launcher)).some((a) => a.id === permissionAskId)) throw new Error('a decided ask is still listed');
      });

      await ctx.step("the agent's re-run of the same call runs (approved), once; the next re-run asks again", async () => {
        (await relayPermission('perm_sess63_rerun')).status(200).body().has('$.approved', true);
        const again = await relayPermission('perm_sess63_rerun2');
        again.status(200).body().has('$.live_wait_ms', 180_000);
        if (again.json<{ approved?: boolean }>().approved) throw new Error('one approval ran two calls');
      });

      await ctx.step('in an unattended session an ask parks at once (live_wait_ms 0) and waits in the list', async () => {
        (await relayPermission('perm_sess63_trigger', unattended)).status(200).body().has('$.live_wait_ms', 0);
        const question = await unattended.sandbox.post(
          '/v1/workspaces/:projectId/turn-question',
          {
            session_id: unattended.sessionId,
            request_id: 'que_sess63',
            runtime_session_id: 'ses_root',
            parkable: true,
            questions: [{ question: 'Which region?', header: 'Region', options: [{ label: 'eu-west-1' }, { label: 'us-east-1' }] }],
          },
          { params },
        );
        question.status(200).body().has('$.live_wait_ms', 0);
        const kinds = (await asksOf(launcher)).filter((a) => a.session_id === unattended.sessionId).map((a) => a.kind).sort();
        if (kinds.join() !== 'permission,question') throw new Error(JSON.stringify(kinds));
      });

      await ctx.step('the launcher answers the parked question → 200; a second answer → 409; a malformed answer → 400', async () => {
        const ask = (await asksOf(launcher)).find((a) => a.kind === 'question' && a.session_id === unattended.sessionId)!;
        (await ctx.client.as(launcher).post(answerRoute, { answers: 'eu-west-1' }, { params: { ...params, askId: ask.id } }))
          .status(400);
        (await ctx.client.as(launcher).post(answerRoute, { answers: [['eu-west-1']] }, { params: { ...params, askId: ask.id } }))
          .status(200);
        (await ctx.client.as(launcher).post(answerRoute, { answers: [['us-east-1']] }, { params: { ...params, askId: ask.id } }))
          .status(409);
      });

      await ctx.step('an unknown ask id → 400; a connector approval is decided on its own route → 400', async () => {
        (await ctx.client.as(launcher).post(answerRoute, { reply: 'once' }, { params: { ...params, askId: 'nonsense' } })).status(400);
        (await ctx.client.as(launcher).post(answerRoute, { decision: 'approve' }, { params: { ...params, askId: 'approval:00000000-0000-0000-0000-000000000000' } }))
          .status(400)
          .body()
          .has('$.code', 'USE_APPROVALS_ROUTE');
      });
    } finally {
      await watched.cleanup();
      await unattended.cleanup();
      await db.end();
    }
  },
);
