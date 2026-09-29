/** Per-kind handlers for `POST /:projectId/turn-stream` — the dispatch targets
 *  the route in `turn-stream.ts` extracts. The route sleeve owns auth, kind
 *  normalization and the two credential scopes, plus the `end`/`turn_end`
 *  settlement (the source-level deadline guard pins its
 *  `completeSandboxTurn` wiring to turn-stream.ts); each handler here owns
 *  one of the other `body.kind`s. Statuses, bodies and side-effect order are
 *  pinned by the characterization set in `turn-stream.test.ts`. */
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { type TeamsFormSpec, buildFormCard } from '../../channels/teams/cards';
import {
  relayTurnAnswerDetailed,
  relayTurnStepDetailed,
} from '../../channels/turn-relay';
import { db } from '../../shared/db';
import {
  abandonSandboxTurn,
  acceptSandboxTurn,
  adoptRuntimeSandboxTurn,
} from '../sandbox-turn-lifecycle';

export interface TurnStreamBody {
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
}

export interface TurnStreamSessionRow {
  sessionId: string;
  accountId: string;
  createdBy: string | null;
  metadata: unknown;
}

/** Everything the per-kind handlers work with, resolved by the route sleeve
 *  before the dispatch. */
export interface TurnStreamContext {
  c: Context;
  projectId: string;
  sessionId: string;
  body: TurnStreamBody;
  authenticatedSandboxId: string | null;
  authenticatedSandboxMetadata: unknown;
  turnStreamSession: TurnStreamSessionRow;
  turnStreamMetadata: Record<string, unknown>;
  childSession: boolean;
}

/** A caller that passed a sandbox-credential kind's wall: the box's own
 *  credential, already scoped to this project and session. */
export type TurnStreamSandboxContext = TurnStreamContext & {
  authenticatedSandboxId: string;
};

/** The sandbox-token wall every upward lifecycle kind sits behind. The four
 *  credential kinds each used to re-hand-write this 403; the dispatcher calls
 *  this once for the group. */
export function requireSandboxCredential(ctx: TurnStreamContext): Response | null {
  if (ctx.authenticatedSandboxId) return null;
  return ctx.c.json({ error: `${ctx.body.kind} requires a sandbox token` }, 403);
}

// The daemon claims its first prompt through the session-bound credential.
// No prompt or turn-ledger identifier belongs in the VM environment.
export function claimInitialTurn(ctx: TurnStreamSandboxContext) {
  const { c, body, authenticatedSandboxMetadata, turnStreamMetadata } = ctx;
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
export async function abandonTurn(ctx: TurnStreamSandboxContext) {
  const { c, body, authenticatedSandboxId } = ctx;
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
export async function acceptTurn(ctx: TurnStreamSandboxContext) {
  const { c, body, authenticatedSandboxId } = ctx;
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
export async function beginTurn(ctx: TurnStreamSandboxContext) {
  const { c, body, authenticatedSandboxId } = ctx;
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

// `opencode_session` carries the canonical opencode ROOT id the sandbox just
// bootstrapped (or reused after a restart). Persist it as the durable pin so
// the Kortix session resolves to the LIVE root with NO dependency on a browser
// ever opening it — closing the null-pin gap that left Slack/trigger/cron
// sessions resolving lazily onto the wrong (orphaned) root. The sandbox token
// is already scoped to this project (checked above); the daemon only ever
// reports its own pin-file root, never a subagent.
export async function pinOpencodeSession(ctx: TurnStreamContext) {
  const { c, body, sessionId, projectId } = ctx;
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

export async function relayContent(ctx: TurnStreamContext) {
  const { c, body, sessionId } = ctx;
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
}
