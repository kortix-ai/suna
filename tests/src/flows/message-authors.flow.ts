/**
 * SESS-42 — Message authors: who wrote each message of a session.
 * Contract: tests/spec/end-to-end.md. Real-Postgres proofs of the query live in
 * `apps/api/src/__tests__/integration-message-authors.test.ts`.
 */
import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';
import { mintWireMessageId } from '../fixtures/session-run';

flow(
  'SESS-42',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/message-authors',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const seed = async (input: Partial<Parameters<typeof createDatabaseSession>[1]> = {}) => {
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id,
        accountId: team.id,
        userId: ctx.P.OWNER.userId!,
        ...input,
      });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    const parent = await seed({ visibility: 'project', metadata: { name: 'Coordinator' } });
    const child = await seed({ visibility: 'project', parentSessionId: parent, metadata: { name: 'Worker', initial_prompt: 'go' } });
    const priv = await seed({ visibility: 'private' });
    const route = '/v1/projects/:projectId/sessions/:sessionId/message-authors';
    type Authors = { authors: Record<string, any>; initial_author: any };

    await ctx.step('a spawned session reports its parent as initial_author and an empty authors map → 200', async () => {
      const r = await owner.get(route, { params: { projectId: project.id, sessionId: child } });
      r.status(200).body().has('$.initial_author.kind', 'session').has('$.initial_author.session_id', parent).has('$.initial_author.name', 'Coordinator');
      if (Object.keys(r.json<Authors>().authors).length !== 0) throw new Error('authors not empty');
    });

    await ctx.step('a top-level session has initial_author null', async () => {
      (await owner.get(route, { params: { projectId: project.id, sessionId: parent } })).status(200).body().has('$.initial_author', null);
    });

    await ctx.step('a prompt the owner sends is attributed to the owner under its wire message id', async () => {
      const messageId = mintWireMessageId();
      const sp = { projectId: project.id, sessionId: parent };
      (await owner.post('/v1/projects/:projectId/sessions/:sessionId/prompts', promptBody('hello', messageId), { params: sp })).status([200, 202]);
      const r = await owner.get(route, { params: sp });
      r.status(200)
        .body()
        .has(`$.authors.${messageId}.kind`, 'member')
        .has(`$.authors.${messageId}.user_id`, ctx.P.OWNER.userId!)
        .has(`$.authors.${messageId}.email`, ctx.P.OWNER.email!);
    });

    await ctx.step('a session the viewer cannot see → 404; a non-UUID id → 400; anonymous → 401', async () => {
      const as = ctx.client.as(member);
      (await as.get(route, { params: { projectId: project.id, sessionId: priv } })).status(404);
      (await as.get(route, { params: { projectId: project.id, sessionId: 'nope' } })).status(400);
      (await ctx.client.as(ctx.P.ANON).get(route, { params: { projectId: project.id, sessionId: parent } })).status(401);
    });
  },
);

function promptBody(text: string, messageId = mintWireMessageId()) {
  return {
    client_message_id: crypto.randomUUID(),
    message_id: messageId,
    remint_on_delivery: false,
    parts: [{ type: 'text', text }],
  };
}
