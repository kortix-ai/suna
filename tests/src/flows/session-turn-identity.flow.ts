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
