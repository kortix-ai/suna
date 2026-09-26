/** Sandbox turn relay: `POST /:projectId/turn-stream` (steps, answers, and turn end). */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import {
  relayTurnAnswerDetailed,
  relayTurnEnd,
  relayTurnStepDetailed,
} from '../../channels/turn-relay';
import { PROJECT_ACTIONS } from '../../iam';
import { setContextField } from '../../lib/request-context';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors } from '../../openapi';
import { db } from '../../shared/db';
import { drainSessionLifecycleQueue } from '../session-lifecycle';
import { promoteNextInboxRow } from '../session-lifecycle/store';
import { reconcileForwardedTurnsAtEnd } from '../session-lifecycle/forwarded-strand-reconcile';
import { captureSessionTranscriptMirror } from '../lib/session-transcript-capture';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { childIdleGraceMs } from '../sandbox-deadline';
import { generateSessionTitleFromFirstPrompt } from '../session-title-generate';
import { turnStreamKindField, turnStreamKindNeedsConnectorWrite } from './turn-stream-kind';
import { notifySessionEvent, turnEndPushType } from '../../notifications/session-push';
import { buildFormCard, type TeamsFormSpec } from '../../channels/teams/cards';
import {
  abandonSandboxTurn,
  acceptSandboxTurn,
  adoptRuntimeSandboxTurn,
  completeSandboxTurn,
  recordUnidentifiedTurnCause,
  turnCompletionAllowsQueuePromotion,
} from '../sandbox-turn-lifecycle';

// POST /v1/projects/:projectId/turn-stream
// Agent-cli relay for the live Slack plan: kind=step appends a checkpoint,
// kind=answer finalizes the turn's streamed message with the agent's reply.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/turn-stream',
    tags: ['projects'],
    summary: 'POST /:projectId/turn-stream',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: {
        description: 'Relay result',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    let body: {
      session_id?: string;
      kind?: string;
      text?: string;
      detail?: string;
      output?: string;
      sources?: Array<{ url?: string; text?: string }>;
      blocks?: unknown[];
      card?: Record<string, unknown>;
      form?: Record<string, unknown>;
      status?: string;
      opencode_session_id?: string;
      turn_message_id?: string;
      turn_token?: string;
      // Turn-end error detail (opencode AssistantMessage.error / session.error),
      // so Slack can render "out of credits" / rate-limit / the real error.
      error_name?: string;
      error_message?: string;
      error_status?: number;
      error_retryable?: boolean;
      error_provider?: string;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    setContextField('kind', turnStreamKindField(body.kind));
    const sessionId = body.session_id?.trim();
    if (!sessionId) {
      return c.json({ error: 'session_id is required' }, 400);
    }

    // Two valid callers: a project/session-scoped PAT (dashboard, operator, or
    // in-sandbox agent CLI) and the session sandbox's own service credential.
    // Each is scoped back to this projectId before a turn event is accepted.
    let authenticatedSandboxId: string | null = null;
    if (isSessionSandboxCredential(c)) {
      const accountId = (c as any).get('accountId') as string | undefined;
      const sandboxId = (c as any).get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'turn-stream requires a sandbox token' }, 403);
      }
      // Sandbox images baked before 2026-07-29 still POST the retired
      // `execution_heartbeat` / `execution_lease_*` kinds here. They fall
      // through to the generic relay below and get a harmless `{ ok: false }`;
      // the in-sandbox reporter treated every non-2xx as best-effort anyway.
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandboxId),
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, accountId),
            inArray(sessionSandboxes.status, ['provisioning', 'active']),
          ),
        )
        .limit(1);
      if (!sandbox) {
        return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
      }
      authenticatedSandboxId = sandbox.sandboxId;
    } else {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Kind-aware capability floor. The connector.write gate protects the
      // CHANNEL-SEND primitives: `step`/`answer` — and any unknown kind — fall
      // through to relayTurnStep/relayTurnAnswer below, which post the agent's
      // content to the project's Slack/Teams. The SANDBOX-reported LIFECYCLE
      // signals carry no content and fan out to no connector: `end`/`turn_end`
      // only shorten this session's idle deadline (LEAST-only — see the comment
      // at the `end` branch below, it can never EXTEND the box's life), and
      // `opencode_session` only persists the root-session pin. Those are exactly
      // what the in-sandbox agent CLI reports over its session/CLI token, which a
      // SCOPED agent grant has no reason to hold connector.write for — gating them
      // 403'd every turn-end report on SampleCo, stranding sandboxes alive for the
      // full idle grace (wasted compute). So exempt the lifecycle kinds and keep
      // the connector gate as the deny-by-default floor for anything that can
      // reach the send path. The IDOR scope (session_id -> projectId) below still
      // applies to every kind, and the `read` floor above still requires
      // membership.
      if (turnStreamKindNeedsConnectorWrite(body.kind)) {
        await assertProjectCapability(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
        );
      }
    }

    let authenticatedSandboxMetadata: unknown = null;
    if (authenticatedSandboxId) {
      const [ownedSession] = await db
        .select({
          sessionId: sessionSandboxes.sessionId,
          metadata: sessionSandboxes.metadata,
        })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, authenticatedSandboxId),
            eq(sessionSandboxes.sessionId, sessionId),
            eq(sessionSandboxes.projectId, projectId),
          ),
        )
        .limit(1);
      if (!ownedSession)
        return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
      authenticatedSandboxMetadata = ownedSession.metadata;
    }

    // session_id is caller-supplied — scope it back to :projectId so a caller
    // authed for their own project can't relay turn events into another
    // tenant's live session (IDOR).
    const [turnStreamSession] = await db
      .select({
        sessionId: projectSessions.sessionId,
        accountId: projectSessions.accountId,
        createdBy: projectSessions.createdBy,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
      )
      .limit(1);
    if (!turnStreamSession) {
      return c.json({ error: 'Not found' }, 404);
    }
    const turnStreamMetadata = (turnStreamSession.metadata ?? {}) as Record<string, unknown>;
    // Coordinator-spawned worker: its idle tail is minutes, not the default
    // grace — the box wakes on demand when the coordinator returns to it.
    const childSession = typeof turnStreamMetadata.spawned_by_session === 'string';

    // The daemon claims its first prompt through the session-bound credential.
    // No prompt or turn-ledger identifier belongs in the VM environment.
    if (body.kind === 'initial_turn_claim') {
      if (!authenticatedSandboxId) {
        return c.json({ error: 'initial_turn_claim requires a sandbox token' }, 403);
      }
      const sandboxMetadata = (authenticatedSandboxMetadata ?? {}) as Record<string, unknown>;
      const activeTurns =
        sandboxMetadata.activeTurns &&
        typeof sandboxMetadata.activeTurns === 'object' &&
        !Array.isArray(sandboxMetadata.activeTurns)
          ? (sandboxMetadata.activeTurns as Record<string, unknown>)
          : {};
      const delivering = Object.entries(activeTurns).find(([, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        return (value as Record<string, unknown>).state === 'delivering';
      });
      const prompt =
        typeof turnStreamMetadata.initial_prompt === 'string'
          ? turnStreamMetadata.initial_prompt.trim()
          : '';
      if (!prompt || !delivering) return c.json({ ok: true, initial_turn: null });
      const [turnToken, rawTurn] = delivering;
      const messageId = (rawTurn as Record<string, unknown>).messageId;
      if (typeof messageId !== 'string' || !messageId.trim()) {
        return c.json({ ok: true, initial_turn: null });
      }
      return c.json({
        ok: true,
        initial_turn: {
          prompt,
          turn_token: turnToken,
          message_id: messageId,
        },
      });
    }

    // A daemon restart can discover that the pre-created initial message was
    // never delivered because it reused a root with older messages. Remove only
    // that token-bound `delivering` record. The sandbox cannot clear an active
    // record through this operation.
    if (body.kind === 'turn_abandoned') {
      if (!authenticatedSandboxId) {
        return c.json({ error: 'turn_abandoned requires a sandbox token' }, 403);
      }
      const turnToken = body.turn_token?.trim();
      if (!turnToken) return c.json({ error: 'turn_token is required' }, 400);
      const ok = await abandonSandboxTurn({ sandboxId: authenticatedSandboxId }, turnToken);
      return c.json({ ok });
    }

    // The API created this token-bound `delivering` record before it provisioned
    // the sandbox. The daemon can promote that exact record after OpenCode
    // accepts the boot prompt. It cannot create a record or revive one removed
    // by terminal evidence. Require the sandbox credential for this upward
    // lifecycle transition; a project/session PAT is not sufficient.
    if (body.kind === 'turn_accepted') {
      if (!authenticatedSandboxId) {
        return c.json({ error: 'turn_accepted requires a sandbox token' }, 403);
      }
      const turnToken = body.turn_token?.trim();
      const opencodeSessionId = body.opencode_session_id?.trim();
      const messageId = body.turn_message_id?.trim();
      if (!turnToken || !opencodeSessionId || !messageId) {
        return c.json(
          {
            error: 'turn_token, opencode_session_id, and turn_message_id are required',
          },
          400,
        );
      }
      const ok = await acceptSandboxTurn({ sandboxId: authenticatedSandboxId }, turnToken, {
        opencodeSessionId,
        messageId,
      });
      return c.json({ ok });
    }

    // A BOX-INITIATED turn: the daemon observed the root go busy on a user
    // message the control plane never delivered (OpenCode's synthetic
    // `<pty_exited>` wake-ups). Adopt it into the ledger so `GET .../turn`
    // reports the running turn and the deadline grant covers it. Idempotent —
    // see adoptRuntimeSandboxTurn; requires the sandbox credential like every
    // upward lifecycle transition.
    if (body.kind === 'turn_begin') {
      if (!authenticatedSandboxId) {
        return c.json({ error: 'turn_begin requires a sandbox token' }, 403);
      }
      const opencodeSessionId = body.opencode_session_id?.trim();
      const messageId = body.turn_message_id?.trim();
      if (!opencodeSessionId || !messageId) {
        return c.json({ error: 'opencode_session_id and turn_message_id are required' }, 400);
      }
      const outcome = await adoptRuntimeSandboxTurn(authenticatedSandboxId, {
        opencodeSessionId,
        messageId,
      });
      return c.json({ ok: outcome === 'adopted' || outcome === 'open_turn_exists', outcome });
    }

    // `end` / `turn_end` carry no text — the sandbox observed the opencode turn
    // finish (idle) or die (error) without the agent closing its Slack message;
    // finalize it gracefully instead of letting it rot into a timeout failure.
    // (`turn_end` is the alias newer sandboxes send, with status + the opencode
    // session id for the server-side root-session guard.)
    if (body.kind === 'end' || body.kind === 'turn_end') {
      const status = body.status === 'error' ? 'error' : 'idle';
      const errorInfo =
        body.error_name || body.error_message || typeof body.error_status === 'number'
          ? {
              name: typeof body.error_name === 'string' ? body.error_name : undefined,
              message: typeof body.error_message === 'string' ? body.error_message : undefined,
              statusCode: typeof body.error_status === 'number' ? body.error_status : undefined,
              isRetryable:
                typeof body.error_retryable === 'boolean' ? body.error_retryable : undefined,
              providerID: typeof body.error_provider === 'string' ? body.error_provider : undefined,
            }
          : undefined;
      // SANDBOX-REPORTED turn end. `shortenSandboxDeadline` is LEAST-only, so
      // it is structurally incapable of EXTENDING the box's life — which is
      // exactly why it is safe to trust a payload the sandbox authored, and
      // why it needs no auth gate of its own. This is the "die 15 minutes
      // after the last turn ended" half of the model.
      //
      // But ONLY for a turn that genuinely ended. `session.error` also fires
      // while opencode is RETRYING (a 429 backoff, a transient upstream 5xx),
      // and pulling the deadline in to 15 minutes there killed the box mid-turn
      // on any backoff longer than that — the exact state the deleted execution
      // lease treated correctly, because it renewed on 'busy' OR 'retry'. The
      // classifier lives with the write (shortenSandboxDeadlineOnTurnEnd) so it
      // cannot be re-wired here without it.
      // A 2xx acknowledges that terminal lifecycle evidence is durable. The
      // daemon retries network/5xx failures and periodically reconciles a lost
      // event. Returning before this write finished made a transient DB failure
      // look successful, so the daemon deduped the event and the active record
      // survived until reaper reconciliation.
      const turnCompletion = await completeSandboxTurn(
        sessionId,
        status,
        {
          opencodeSessionId:
            typeof body.opencode_session_id === 'string' ? body.opencode_session_id : undefined,
          messageId: typeof body.turn_message_id === 'string' ? body.turn_message_id : undefined,
        },
        errorInfo,
        childSession ? childIdleGraceMs() : undefined,
      );
      // The memory guard reports its cause in a frame of its own, after the
      // abort. A daemon built before 2026-09-21 sends it with no
      // `turn_message_id` and `error_retryable: true`, which settles nothing
      // above. Attach the cause to the turn it stopped, or the UI says "No
      // reason was reported" under a turn the sandbox killed on purpose.
      if (
        status === 'error' &&
        body.error_name === 'SandboxMemoryGuard' &&
        typeof body.turn_message_id !== 'string' &&
        turnCompletion.outcome !== 'closed'
      ) {
        const causeOutcome = await recordUnidentifiedTurnCause(
          sessionId,
          typeof body.opencode_session_id === 'string' ? body.opencode_session_id : null,
          {
            name: body.error_name,
            message: typeof body.error_message === 'string' ? body.error_message : null,
          },
        );
        console.info('[turn-stream] unidentified turn cause', {
          sessionId,
          name: body.error_name,
          outcome: causeOutcome,
        });
      }
      // Prompts forwarded INTO the turn that just ended: close the ones the
      // step answered (older than the ended message), and re-queue any that
      // the loop stranded below a newer assistant — see
      // forwarded-strand-reconcile.ts. Fire-and-forget: it reads the box once
      // and must not hold the daemon's relay.
      if (!childSession) {
        void reconcileForwardedTurnsAtEnd({
          sessionId,
          opencodeSessionId:
            typeof body.opencode_session_id === 'string' ? body.opencode_session_id : null,
          endedMessageId: typeof body.turn_message_id === 'string' ? body.turn_message_id : null,
        }).catch((err) =>
          console.warn(
            `[forwarded-turns] reconcile failed for session ${sessionId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
      }
      // THE TURN ENDED, SO THE TRANSCRIPT IS FINAL — mirror it.
      //
      // This is the one instant the deleted client-side mirror could not
      // observe (its freshness test read the transcript's SHAPE, and a STOP
      // moves none of that), which is why the SERVER writes the copy here
      // rather than the browser writing it on a timer. The box is definitionally
      // reachable — it just relayed — and both halves of the turn are settled.
      // Fire-and-forget beside the reconcile above: a mirror write must never be
      // able to fail a turn-end report, and `captureSessionTranscriptMirror`
      // never throws.
      if (!childSession) {
        void captureSessionTranscriptMirror(sessionId);
      }
      // THE TURN ENDED — the session's next queued prompt is admissible NOW.
      // Await the durable promotion before acknowledging the terminal relay.
      // The targeted drain remains asynchronous and re-runs admission itself;
      // a lost kick falls back to the scheduler tick.
      // This is what makes the queue "send between every turn" without a
      // clock: the daemon's idle relay is the trigger.
      let promotedPromptId: string | null = null;
      if (!childSession) {
        if (turnCompletionAllowsQueuePromotion(turnCompletion)) {
          promotedPromptId = await promoteNextInboxRow(sessionId);
          if (promotedPromptId) {
            void drainSessionLifecycleQueue({ idempotencyKey: promotedPromptId, coalesce: false }).catch((error) =>
              console.warn('[turn-stream] targeted queue drain failed', {
                sessionId,
                promptId: promotedPromptId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        }
        console.info('[turn-stream] terminal turn settlement', {
          sessionId,
          opencodeSessionId:
            typeof body.opencode_session_id === 'string' ? body.opencode_session_id : null,
          turnMessageId: typeof body.turn_message_id === 'string' ? body.turn_message_id : null,
          outcome: turnCompletion.outcome,
          activeTurnCount: turnCompletion.activeTurnCount,
          closedTurnCount: turnCompletion.closedTurnCount,
          queuePromoted: promotedPromptId !== null,
          promotedPromptId,
        });
      }
      // Push the session creator's devices. Only an end that closed a turn in
      // THIS call notifies (see turnEndPushType); replays and aborts do not,
      // and a promoted queued prompt means the session is still running, so
      // it gets no completion push. Fire-and-forget: a push must never delay
      // or fail the relay.
      const pushType = turnEndPushType({
        outcome: turnCompletion.outcome,
        status,
        errorName: errorInfo?.name,
        childSession,
        promoted: promotedPromptId !== null,
      });
      if (pushType) {
        void notifySessionEvent({ type: pushType, sessionId, projectId }).catch((err) =>
          console.warn('[push] turn-end notification failed', err instanceof Error ? err.message : err),
        );
      }
      // Second-chance auto-title: create-time generation is a single in-memory
      // best-effort call, and a session whose only prompt was baked in-guest
      // (the server-claimed initial prompt) never crosses a titling hook again. Turn end
      // is the natural retry point — the generator is idempotent (needsTitle +
      // CAS) so an already-titled session is a cheap no-op. The stored
      // `title_source` outranks the supplied text inside the generator.
      const titleRetrySource = [
        turnStreamMetadata.title_source,
        turnStreamMetadata.initial_prompt,
      ].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (titleRetrySource && turnStreamSession.createdBy) {
        void generateSessionTitleFromFirstPrompt({
          projectId,
          sessionId,
          accountId: turnStreamSession.accountId,
          userId: turnStreamSession.createdBy,
          firstPromptText: titleRetrySource,
        }).catch((err) =>
          console.warn(
            `[title-generate] turn-end retry failed for session ${sessionId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
      }
      // An end whose identity does not match the ledger's active turn is a
      // replay of some OTHER turn (a runtime waking for a follow-up re-emits
      // the previous turn's idle). Relaying it closed and deleted the Slack
      // turn row of the run that had just started
      // (INC-2026-09-08-CONNECTOR-GATEWAY, S2/S3). The ledger already refused
      // to close its own turn for this; the channel relay now agrees.
      const relayEnd = turnCompletion.outcome !== 'identity_mismatch';
      if (!relayEnd) {
        console.warn('[turn-stream] turn-end relay skipped — identity mismatch with the active turn', {
          sessionId,
          status,
          turnMessageId: typeof body.turn_message_id === 'string' ? body.turn_message_id : null,
          activeTurnCount: turnCompletion.activeTurnCount,
        });
      }
      const ok = relayEnd ? await relayTurnEnd(sessionId, status, errorInfo) : false;
      return c.json({
        ok,
        turn_completion: {
          outcome: turnCompletion.outcome,
          active_turn_count: turnCompletion.activeTurnCount,
          closed_turn_count: turnCompletion.closedTurnCount,
        },
        queue_promoted: promotedPromptId !== null,
        promoted_prompt_id: promotedPromptId,
      });
    }

    // `opencode_session` carries the canonical opencode ROOT id the sandbox just
    // bootstrapped (or reused after a restart). Persist it as the durable pin so
    // the Kortix session resolves to the LIVE root with NO dependency on a browser
    // ever opening it — closing the null-pin gap that left Slack/trigger/cron
    // sessions resolving lazily onto the wrong (orphaned) root. The sandbox token
    // is already scoped to this project (checked above); the daemon only ever
    // reports its own pin-file root, never a subagent.
    if (body.kind === 'opencode_session') {
      const ocId = body.opencode_session_id?.trim();
      if (!ocId) return c.json({ error: 'opencode_session_id is required' }, 400);
      const updated = await db
        .update(projectSessions)
        .set({ opencodeSessionId: ocId, updatedAt: new Date() })
        .where(
          and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)),
        )
        .returning({ sessionId: projectSessions.sessionId });
      return c.json({ ok: updated.length > 0 });
    }

    const text = (body.text ?? '').trim();
    if (!text) {
      return c.json({ error: 'text is required' }, 400);
    }

    const detail = body.detail?.trim() || undefined;
    const outputForPrev = body.output?.trim() || undefined;
    const sourcesForPrev = Array.isArray(body.sources)
      ? body.sources
          .filter((s): s is { url: string; text: string } => !!s?.url && !!s?.text)
          .map((s) => ({ url: s.url, text: s.text }))
      : undefined;
    const blocks = Array.isArray(body.blocks) && body.blocks.length > 0 ? body.blocks : undefined;
    // A full Adaptive Card for the Teams answer (`teams send --card-file`).
    // `form` is the safe alternative: the agent describes the FIELDS and the
    // server builds the card, so the submit verb and the branding cannot
    // drift and a malformed spec fails here instead of rendering a dead
    // button. See channels/teams/cards.ts buildFormCard.
    const formSpec =
      body.form && typeof body.form === 'object' && !Array.isArray(body.form)
        ? (body.form as unknown as TeamsFormSpec)
        : undefined;
    const card = formSpec
      ? (buildFormCard(formSpec) ?? undefined)
      : body.card && typeof body.card === 'object' && !Array.isArray(body.card)
        ? (body.card as Record<string, unknown>)
        : undefined;
    if (formSpec && !card) {
      return c.json(
        { ok: false, reason: 'invalid_form', error: 'the form needs at least one field with an id and a label' },
        400,
      );
    }

    // `reason` is what makes `ok: false` actionable in the sandbox: `slack
    // step` and `slack send` print it, so an agent can tell "no Slack turn is
    // open for this run" from "Slack refused the post" and act on it instead
    // of assuming its progress was delivered.
    const relayed =
      body.kind === 'answer'
        ? await relayTurnAnswerDetailed(sessionId, text, blocks, card)
        : await relayTurnStepDetailed(sessionId, text, {
            detail,
            outputForPrev,
            sourcesForPrev,
          });
    return c.json(relayed.ok ? { ok: true } : { ok: false, reason: relayed.reason });
  },
);
