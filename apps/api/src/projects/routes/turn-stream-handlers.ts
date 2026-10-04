/**
 * Per-kind handlers for `POST /:projectId/turn-stream`.
 *
 * The route sleeve in `turn-stream.ts` owns the two credential scopes and the
 * `kind` normalization; every `body.kind` dispatches to one function here. The
 * bodies are moved verbatim, so the traffic contract — statuses, response
 * fields, and side-effect order — is unchanged.
 */
import type { TurnStreamRelayBody } from '@kortix/api-contract/runtime-relay';
import { isTurnErrorCode } from '@kortix/api-contract/transcript';
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { type TeamsFormSpec, buildFormCard } from '../../channels/teams/cards';
import {
  relayTurnAnswerDetailed,
  relayTurnEnd,
  relayTurnStepDetailed,
} from '../../channels/turn-relay';
import { notifySessionEvent, turnEndPushType } from '../../notifications/session-push';
import { db } from '../../lib/db';
import { captureSessionTranscriptMirror } from '../../services/sessions/session-transcript-capture';
import { recordTriggerRunEnd } from '../../services/triggers/trigger-run-outcome';
import { childIdleGraceMs } from '../../services/sandboxes/sandbox-deadline';
import {
  abandonSandboxTurn,
  acceptSandboxTurn,
  adoptRuntimeSandboxTurn,
  completeSandboxTurn,
} from '../../services/sandboxes/sandbox-turn-lifecycle';
import { drainSessionLifecycleQueue } from '../../services/sessions/lifecycle';
import { reconcileForwardedTurnsAtEnd } from '../../services/sessions/lifecycle/forwarded-strand-reconcile';
import { promoteNextInboxRow } from '../../services/sessions/lifecycle/store';
import { generateSessionTitleFromFirstPrompt } from '../../services/sessions/session-title-generate';
import {
  recordUnidentifiedTurnCause,
  turnCompletionAllowsQueuePromotion,
} from '../../services/sessions/session-turn-ledger';

/** The relay request body, shape only — the route parses JSON into this. */
export type TurnStreamBody = Partial<TurnStreamRelayBody>;

/** The only surface these handlers use from the Hono context. */
export interface RelayResponder {
  json: (body: unknown, status?: number) => Response;
}

/** What the `end` / `turn_end` handler needs from the sleeve. */
export interface TurnEndContext {
  projectId: string;
  sessionId: string;
  /** Coordinator-spawned worker: its idle tail is minutes, not the default grace. */
  childSession: boolean;
  turnStreamMetadata: Record<string, unknown>;
  turnStreamSession: { accountId: string; createdBy: string | null };
}

/**
 * The upward-lifecycle kinds require the session sandbox's own credential —
 * a project/session PAT cannot promote a token-bound turn record. One guard
 * returns the 403 wall each kind used to hand-write, or null when the caller
 * presented the sandbox credential.
 */
export function requireSandboxCredential(
  c: RelayResponder,
  authenticatedSandboxId: string | null,
  kind: string,
): Response | null {
  if (authenticatedSandboxId) return null;
  return c.json({ error: `${kind} requires a sandbox token` }, 403);
}

// The daemon claims its first prompt through the session-bound credential.
// No prompt or turn-ledger identifier belongs in the VM environment.
// The answer also carries the durable OpenCode root pin. A daemon without a
// local pin file (a converged legacy box, a rebuilt home) must resume THAT
// root. Otherwise it adopts or creates another root and relays it over the
// pin, and the session opens on an empty conversation (prod 2026-09-23).
export function claimInitialTurn(
  c: RelayResponder,
  authenticatedSandboxId: string | null,
  authenticatedSandboxMetadata: unknown,
  turnStreamMetadata: Record<string, unknown>,
  opencodeSessionId: string | null,
): Response {
  const denial = requireSandboxCredential(c, authenticatedSandboxId, 'initial_turn_claim');
  if (denial) return denial;
  // The pinned root, under its W3 name and its pre-W3 name (an older daemon reads it).
  const pin = { runtime_session_id: opencodeSessionId, opencode_session_id: opencodeSessionId };
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
  if (!prompt || !delivering) return c.json({ ok: true, initial_turn: null, ...pin });
  const [turnToken, rawTurn] = delivering;
  const messageId = (rawTurn as Record<string, unknown>).messageId;
  if (typeof messageId !== 'string' || !messageId.trim()) {
    return c.json({ ok: true, initial_turn: null, ...pin });
  }
  return c.json({
    ok: true,
    initial_turn: {
      prompt,
      turn_token: turnToken,
      message_id: messageId,
    },
    ...pin,
  });
}

// A daemon restart can discover that the pre-created initial message was
// never delivered because it reused a root with older messages. Remove only
// that token-bound `delivering` record. The sandbox cannot clear an active
// record through this operation.
export async function abandonTurn(
  c: RelayResponder,
  body: TurnStreamBody,
  authenticatedSandboxId: string | null,
): Promise<Response | null> {
  if (!authenticatedSandboxId) {
    return requireSandboxCredential(c, authenticatedSandboxId, 'turn_abandoned');
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
export async function acceptTurn(
  c: RelayResponder,
  body: TurnStreamBody,
  authenticatedSandboxId: string | null,
): Promise<Response | null> {
  if (!authenticatedSandboxId) {
    return requireSandboxCredential(c, authenticatedSandboxId, 'turn_accepted');
  }
  const turnToken = body.turn_token?.trim();
  const opencodeSessionId = body.runtime_session_id?.trim();
  const messageId = body.turn_message_id?.trim();
  if (!turnToken || !opencodeSessionId || !messageId) {
    return c.json(
      {
        error: 'turn_token, runtime_session_id, and turn_message_id are required',
      },
      400,
    );
  }
  const ok = await acceptSandboxTurn({ sandboxId: authenticatedSandboxId }, turnToken, {
    runtimeSessionId: opencodeSessionId,
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
export async function beginTurn(
  c: RelayResponder,
  body: TurnStreamBody,
  authenticatedSandboxId: string | null,
): Promise<Response | null> {
  if (!authenticatedSandboxId) {
    return requireSandboxCredential(c, authenticatedSandboxId, 'turn_begin');
  }
  const opencodeSessionId = body.runtime_session_id?.trim();
  const messageId = body.turn_message_id?.trim();
  if (!opencodeSessionId || !messageId) {
    return c.json({ error: 'runtime_session_id and turn_message_id are required' }, 400);
  }
  const outcome = await adoptRuntimeSandboxTurn(authenticatedSandboxId, {
    runtimeSessionId: opencodeSessionId,
    messageId,
  });
  return c.json({ ok: outcome === 'adopted' || outcome === 'open_turn_exists', outcome });
}

/** The durable half of a turn end: settle the ledger and attach a bare cause. */
async function settleTurnLedger(sessionId: string, body: TurnStreamBody, childSession: boolean) {
  const status: 'idle' | 'error' = body.status === 'error' ? 'error' : 'idle';
  const errorInfo =
    body.error_name || body.error_message || typeof body.error_status === 'number'
      ? {
          name: typeof body.error_name === 'string' ? body.error_name : undefined,
          message: typeof body.error_message === 'string' ? body.error_message : undefined,
          statusCode: typeof body.error_status === 'number' ? body.error_status : undefined,
          isRetryable: typeof body.error_retryable === 'boolean' ? body.error_retryable : undefined,
          providerID: typeof body.error_provider === 'string' ? body.error_provider : undefined,
          code: isTurnErrorCode(body.error_code) ? body.error_code : undefined,
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
      runtimeSessionId:
        typeof body.runtime_session_id === 'string' ? body.runtime_session_id : undefined,
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
      typeof body.runtime_session_id === 'string' ? body.runtime_session_id : null,
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
  return { status, errorInfo, turnCompletion };
}

/**
 * The post-settlement fan-out: reconcile forwarded turns, mirror the finished
 * transcript, then admit the session's next queued prompt. Fire-and-forget
 * except the durable promotion, which the ack must wait for.
 */
async function promoteAfterTurnEnd(
  ctx: TurnEndContext,
  body: TurnStreamBody,
  settled: Awaited<ReturnType<typeof settleTurnLedger>>,
): Promise<string | null> {
  const { sessionId, childSession } = ctx;
  const { turnCompletion } = settled;
  // Prompts forwarded INTO the turn that just ended: close the ones the
  // step answered (older than the ended message), and re-queue any that
  // the loop stranded below a newer assistant — see
  // forwarded-strand-reconcile.ts. Fire-and-forget: it reads the box once
  // and must not hold the daemon's relay.
  if (!childSession) {
    void reconcileForwardedTurnsAtEnd({
      sessionId,
      opencodeSessionId:
        typeof body.runtime_session_id === 'string' ? body.runtime_session_id : null,
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
  //
  // EVERY session, a coordinator-spawned one included: it runs in its own
  // sandbox with its own OpenCode root, and nobody may ever open it, so this
  // turn end is the only moment its history is saved. Skipping it served
  // `available: false` and a loading bar to the first person who looked.
  void captureSessionTranscriptMirror(sessionId);
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
        void drainSessionLifecycleQueue({
          idempotencyKey: promotedPromptId,
          coalesce: false,
        }).catch((error) =>
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
        typeof body.runtime_session_id === 'string' ? body.runtime_session_id : null,
      turnMessageId: typeof body.turn_message_id === 'string' ? body.turn_message_id : null,
      outcome: turnCompletion.outcome,
      activeTurnCount: turnCompletion.activeTurnCount,
      closedTurnCount: turnCompletion.closedTurnCount,
      queuePromoted: promotedPromptId !== null,
      promotedPromptId,
    });
  }
  return promotedPromptId;
}

/** Push, auto-title retry, the relay gate, and the terminal response. */
async function publishTurnEnd(
  c: RelayResponder,
  ctx: TurnEndContext,
  body: TurnStreamBody,
  settled: Awaited<ReturnType<typeof settleTurnLedger>>,
  promotedPromptId: string | null,
): Promise<Response> {
  const { projectId, sessionId, childSession, turnStreamMetadata, turnStreamSession } = ctx;
  const { status, errorInfo, turnCompletion } = settled;
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
  // A trigger session's creator is the agent's service account, so the push
  // above reaches nobody. Record the run on its trigger and tell the owner.
  try {
    await recordTriggerRunEnd({
      projectId,
      accountId: turnStreamSession.accountId,
      sessionId,
      metadata: turnStreamMetadata,
      status,
      error: errorInfo,
      outcome: turnCompletion.outcome,
      childSession,
    });
  } catch (err) {
    console.warn('[turn-stream] trigger run outcome not recorded', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
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

// `end` / `turn_end` carry no text — the sandbox observed the opencode turn
// finish (idle) or die (error) without the agent closing its Slack message;
// finalize it gracefully instead of letting it rot into a timeout failure.
// (`turn_end` is the alias newer sandboxes send, with status + the opencode
// session id for the server-side root-session guard.)
export async function settleTurnEnd(
  c: RelayResponder,
  body: TurnStreamBody,
  ctx: TurnEndContext,
): Promise<Response> {
  const settled = await settleTurnLedger(ctx.sessionId, body, ctx.childSession);
  const promotedPromptId = await promoteAfterTurnEnd(ctx, body, settled);
  return publishTurnEnd(c, ctx, body, settled, promotedPromptId);
}

// `runtime_session` carries the canonical runtime ROOT id the sandbox just
// bootstrapped (or reused after a restart). Persist it as the durable pin so
// the Kortix session resolves to the LIVE root with NO dependency on a browser
// ever opening it — closing the null-pin gap that left Slack/trigger/cron
// sessions resolving lazily onto the wrong (orphaned) root. The sandbox token
// is already scoped to this project (checked above); the daemon only ever
// reports its own pin-file root, never a subagent.
export async function pinOpencodeSession(
  c: RelayResponder,
  body: TurnStreamBody,
  projectId: string,
  sessionId: string,
): Promise<Response> {
  const ocId = body.runtime_session_id?.trim();
  if (!ocId) return c.json({ error: 'runtime_session_id is required' }, 400);
  const updated = await db
    .update(projectSessions)
    .set({ runtimeSessionId: ocId, updatedAt: new Date() })
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .returning({ sessionId: projectSessions.sessionId });
  return c.json({ ok: updated.length > 0 });
}

/** The content-bearing `step` / `answer` relay, and the deny-by-default fall-through. */
export async function relayContent(
  c: RelayResponder,
  body: TurnStreamBody,
  sessionId: string,
): Promise<Response> {
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
      {
        ok: false,
        reason: 'invalid_form',
        error: 'the form needs at least one field with an id and a label',
      },
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
}
