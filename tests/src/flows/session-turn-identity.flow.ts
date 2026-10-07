/**
 * SESS-39 — the session credential acts as the person who started the turn.
 *
 * One sandbox holds one Kortix credential (`KORTIX_TOKEN`) for its whole life.
 * When another member prompts a shared session, every call the agent makes in
 * that turn must act as that member. The agent proves it from inside the box:
 * it calls `GET /accounts/me` with its own credential and reports the email.
 *
 * Needs a booted sandbox: `requires: ['daytona', 'funded']`, so the local
 * runner skips it and it runs against a deployed target. The bind itself is
 * pinned without a runtime by `integration-session-turn-identity.test.ts`.
 */
import { flow } from '../core/flow';
import { isKe2eRetryableError } from '../core/client';
import { waitFor } from '../core/poll';
import type { Principal } from '../core/types';
import { subscribe } from '../fixtures/billing';
import { createDatabaseSession, seedDatabaseRunningFirstPrompt } from '../fixtures/database-project';
import { mintWireMessageId, readTranscript, waitForSessionReady } from '../fixtures/session-run';

const probe = (nonce: string) =>
  'Run this shell command: curl -s -H "Authorization: Bearer $KORTIX_TOKEN" "$KORTIX_API_URL/accounts/me" ' +
  `— then reply with exactly one line: "${nonce} <email>", where <email> is the "email" field of its JSON output.`;

flow(
  'SESS-39',
  {
    domain: 'sessions',
    requires: ['daytona', 'funded'],
    // A cold Daytona image build can take ~7 min before the first turn.
    timeoutMs: 1_200_000,
    routes: [
      'PUT /v1/projects/:projectId/sessions/:sessionId/sharing',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    ],
  },
  async (ctx) => {
    // Two humans of one account: the owner and an account admin. Team-scoped
    // principals exist only on a team account, so the flow funds its own.
    const team = await ctx.fixtures.team();
    await ctx.step('fund the team account', async () => {
      await subscribe(ctx.env, ctx.client.as(ctx.P.OWNER), team.id);
    });
    const admin = await team.addMember('admin');
    const project = await team.project({ seed: true });
    const session = await ctx.fixtures.session(project);
    const params = { projectId: project.id, sessionId: session.id };
    const run = Date.now().toString(36);

    await ctx.step("the owner's session is ready and shared with the project", async () => {
      await waitForSessionReady(ctx, project.id, session.id, 540_000);
      const shared = await ctx.client
        .as(ctx.P.OWNER)
        .put('/v1/projects/:projectId/sessions/:sessionId/sharing', { mode: 'project' }, { params });
      shared.status(200);
    });

    const turn = (who: Principal, label: string, n: number) =>
      ctx.step(`${label} prompts; the agent's own credential answers GET /accounts/me as ${label}`, async () => {
        if (!who.email) throw new Error(`${label} has no email in the principal matrix`);
        const nonce = `sess39-${run}-${n}`;
        const sent = await ctx.client.as(who).post(
          '/v1/projects/:projectId/sessions/:sessionId/prompts',
          {
            client_message_id: crypto.randomUUID(),
            message_id: mintWireMessageId(),
            remint_on_delivery: true,
            parts: [{ type: 'text', text: probe(nonce) }],
          },
          { params },
        );
        sent.status([200, 202]);
        const answer = new RegExp(`${nonce}\\s+(\\S+@\\S+)`);
        const read = await waitFor(() => readTranscript(ctx, project.id, session.id), {
          until: (t) => t.messages.some((m) => m.role === 'assistant' && answer.test(m.text)),
          timeoutMs: 240_000,
          intervalMs: 4_000,
          description: `the agent's "${nonce} <email>" reply in session ${session.id}`,
          retryOnError: isKe2eRetryableError,
        });
        const reply = read.messages.filter((m) => m.role === 'assistant' && answer.test(m.text)).at(-1)!;
        const email = reply.text.match(answer)![1]!.replace(/[`"'.,]+$/, '').toLowerCase();
        if (email !== who.email.toLowerCase()) {
          throw new Error(`turn ${n} was started by ${who.email}, but the session credential acted as ${email}`);
        }
      });

    await turn(ctx.P.OWNER, 'the owner', 1);
    await turn(admin, 'an account admin', 2);
    await turn(ctx.P.OWNER, 'the owner', 3);
  },
);

/**
 * SESS-47 — a queued prompt runs as its author, so only its author writes it.
 *
 * The drain binds the session credential to the prompt's author (SESS-39), so
 * a prompt runs with its author's role, budget and connections. Another member
 * who could edit, send now or Stop-and-send it would run their own text as the
 * author. Removal is the author's, or a session manager's. Local: the session
 * is seeded in the database with a first prompt on its way, so every prompt
 * sent afterwards waits and no sandbox is needed.
 */
flow(
  'SESS-47',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: [
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'GET /v1/projects/:projectId/sessions/:sessionId/prompts',
      'PATCH /v1/projects/:projectId/sessions/:sessionId/prompts/:promptId',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts/:promptId/retry',
      'DELETE /v1/projects/:projectId/sessions/:sessionId/prompts/:promptId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    // The owner's session, open to the whole project.
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: team.id,
      userId: ctx.P.OWNER.userId!,
      visibility: 'project',
    });
    ctx.track('session', sessionId, { projectId: project.id });
    await seedDatabaseRunningFirstPrompt(ctx.env, {
      projectId: project.id,
      sessionId,
      accountId: team.id,
      userId: ctx.P.OWNER.userId!,
    });
    const params = { projectId: project.id, sessionId };
    const PROMPTS = '/v1/projects/:projectId/sessions/:sessionId/prompts';
    const PROMPT = '/v1/projects/:projectId/sessions/:sessionId/prompts/:promptId';
    type Listed = { prompt_id: string; full_text: string; author_user_id?: string | null };
    const send = async (as: typeof owner, text: string) => {
      const r = await as.post(
        PROMPTS,
        {
          client_message_id: crypto.randomUUID(),
          message_id: mintWireMessageId(),
          remint_on_delivery: false,
          parts: [{ type: 'text', text }],
          placement: 'composer',
          delivery: 'queue',
        },
        { params },
      );
      r.status([200, 202]);
      return r.json<{ prompt_id: string }>().prompt_id;
    };
    const listed = async (promptId: string) => {
      const r = await owner.get(PROMPTS, { params });
      r.status(200);
      return r.json<{ prompts: Listed[] }>().prompts.find((p) => p.prompt_id === promptId);
    };
    const notAuthor = (r: Awaited<ReturnType<typeof owner.get>>) =>
      r.status(403).body().has('$.code', 'not_prompt_author');

    let ownerPrompt = '';
    await ctx.step('the owner queues a prompt; the list names the owner as its author', async () => {
      ownerPrompt = await send(owner, 'owner text');
      const row = await listed(ownerPrompt);
      if (!row) throw new Error("the owner's prompt is not listed");
      if (row.author_user_id !== ctx.P.OWNER.userId) {
        throw new Error(`author_user_id is ${String(row.author_user_id)}, expected the owner`);
      }
    });

    await ctx.step('another member cannot edit it → 403 not_prompt_author; the text is unchanged', async () => {
      notAuthor(await asMember.patch(PROMPT, { text: 'member text' }, { params: { ...params, promptId: ownerPrompt } }));
      const row = await listed(ownerPrompt);
      if (row?.full_text !== 'owner text') throw new Error(`text changed to ${String(row?.full_text)}`);
    });

    await ctx.step('… nor Stop and send it, nor send it now → 403', async () => {
      notAuthor(await asMember.patch(PROMPT, { delivery: 'interrupt' }, { params: { ...params, promptId: ownerPrompt } }));
      notAuthor(await asMember.post(`${PROMPT}/retry`, {}, { params: { ...params, promptId: ownerPrompt } }));
    });

    await ctx.step('… nor remove it → 403; it is still listed', async () => {
      notAuthor(await asMember.del(PROMPT, { params: { ...params, promptId: ownerPrompt } }));
      if (!(await listed(ownerPrompt))) throw new Error("the member's DELETE removed the owner's prompt");
    });

    await ctx.step('the author edits it → 200, and the new text is listed', async () => {
      const r = await owner.patch(PROMPT, { text: 'owner edited' }, { params: { ...params, promptId: ownerPrompt } });
      r.status(200).body().has('$.full_text', 'owner edited').has('$.author_user_id', ctx.P.OWNER.userId!);
    });

    let memberPrompt = '';
    await ctx.step('the member queues and edits their own prompt → 200', async () => {
      memberPrompt = await send(asMember, 'member text');
      const r = await asMember.patch(PROMPT, { text: 'member edited' }, { params: { ...params, promptId: memberPrompt } });
      r.status(200).body().has('$.full_text', 'member edited').has('$.author_user_id', member.userId!);
    });

    await ctx.step("the session's owner removes the member's prompt → 200, and it leaves the list", async () => {
      const r = await owner.del(PROMPT, { params: { ...params, promptId: memberPrompt } });
      r.status(200);
      if (await listed(memberPrompt)) throw new Error("the member's prompt is still listed");
    });
  },
);
