/**
 * The durable record of a sandbox turn, and everything shared around it.
 *
 * A turn record lives in two places: the token-keyed `activeTurns` entry in
 * `session_sandboxes.metadata` (the lifecycle authority) and one row per turn
 * in `kortix.session_turns` (the history). This module owns the record itself —
 * its stored shape (`storedSandboxTurns`, `parseStoredSandboxTurn`), the
 * identity it carries (`SandboxTurnIdentity`, `extractTurnIdentity`), its
 * lifecycle vocabulary, and every statement over `kortix.session_turns` plus
 * the settle backstops that keep that table complete.
 *
 * Ledger writes are OBSERVATION, never authority; a failed ledger write must
 * never fail a prompt, a turn acceptance, or a reaper pass. Log and continue.
 *
 * It is the lower layer — the authority writers over the metadata live in
 * ./sandbox-turn-lifecycle.ts and call into this module to record what they
 * erased — so the shared SQL plumbing (`execute`, `normalizeRows`, `secs`)
 * lives here and the dependency direction stays one-way.
 */

import { classifyRuntimeRequest, turnStartBodyFields } from '../sandbox-proxy/runtime-request';
import { randomUUID } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import { mintWireMessageId } from './wire-message-id';

export interface SandboxTurnIdentity {
  runtimeSessionId: string;
  messageId: string | null;
}

/**
 * A stored turn record names its runtime session under `runtimeSessionId` and,
 * for an API instance built before W4 that still serves during a rolling
 * deploy, under `opencodeSessionId` too. Writers set both; readers take the
 * neutral key first.
 * ponytail: drop the `opencodeSessionId` write once no pre-W4 API instance runs.
 */
function storedTurnRuntimeSessionId(turn: Record<string, unknown>): unknown {
  return turn.runtimeSessionId ?? turn.opencodeSessionId;
}

let databasePromise: Promise<typeof import('../lib/db')['db']> | null = null;
function database() {
  databasePromise ??= import('../lib/db').then((module) => module.db);
  return databasePromise;
}

export async function execute(query: SQL) {
  return (await database()).execute(query);
}

export const secs = (ms: number) => Math.round(ms / 1000);

export function normalizeRows(result: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : null;
}

export interface PreparedInitialSandboxTurn {
  token: string;
  messageId: string;
  startedAtMs: number;
}
export type SandboxTurnStartObservation = 'granted' | 'no_box';
export type ActiveTurnRenewal = 'renewed' | 'inactive';
export type SandboxTurnObservation = 'active' | 'terminal' | 'unknown';
export type SandboxTurnDeliveryReconciliation = 'active' | 'inactive' | 'deferred';
export interface StoredSandboxTurn extends SandboxTurnIdentity {
  token: string;
  state: 'delivering' | 'active';
  /**
   * When the control plane minted this turn. Null for a record written before
   * `startedAtMs` existed — those carry no start instant, and inventing one
   * would make a reader trust a number nobody measured.
   */
  startedAtMs: number | null;
}
/**
 * Iterate a sandbox row's live turn metadata: the `activeTurns` object when it
 * is one, nothing otherwise. The jsonb_each alias is `entry`.
 */
export function activeTurnEntries(metadata: SQL): SQL {
  return sql`jsonb_each(CASE
          WHEN jsonb_typeof(${metadata}->'activeTurns') = 'object'
            THEN ${metadata}->'activeTurns'
          ELSE '{}'::jsonb
        END) entry`;
}

/**
 * The next-state projection both multi-turn end writers share: erase every
 * turn the `selected` CTE matched from `activeTurns`, keep every other entry,
 * and return the turns it erased as `ended_turns` for the ledger settle.
 * References the `target` and `selected` CTE names of the enclosing statement.
 */
export function removeAndReturnTurns(): SQL {
  return sql`SELECT target.sandbox_id,
             jsonb_set(
               target.metadata,
               '{activeTurns}',
               coalesce((
                 SELECT jsonb_object_agg(entry.key, entry.value)
                   FROM ${activeTurnEntries(sql`target.metadata`)}
                  WHERE NOT EXISTS (
                    SELECT 1 FROM selected
                     WHERE selected.sandbox_id = target.sandbox_id
                       AND selected.key = entry.key)),
                 '{}'::jsonb),
               true) AS metadata,
             (SELECT coalesce(
                       jsonb_agg(jsonb_build_object(
                         'token', selected.token,
                         'runtimeSessionId', coalesce(selected.value->>'runtimeSessionId', selected.value->>'opencodeSessionId'),
                         'messageId', selected.value->>'messageId',
                         'startedAtMs', selected.value->>'startedAtMs'))
                         FILTER (WHERE selected.token IS NOT NULL),
                       '[]'::jsonb)
                FROM selected
               WHERE selected.sandbox_id = target.sandbox_id) AS ended_turns
        FROM target`;
}
/**
 * Mint the identity that crosses the API -> provider -> daemon boundary for a
 * prompt delivered directly by the daemon during boot. The sandbox receives
 * the opaque token, but it cannot create or revive the matching database row.
 */
export function prepareInitialSandboxTurn(nowMs = Date.now()): PreparedInitialSandboxTurn {
  return {
    token: randomUUID(),
    // OpenCode <= 1.18.14 compares message ids to decide whether the initial
    // user message already has an answer. A UUID-like id sorts after every
    // native assistant id and makes the runtime answer the same prompt forever.
    messageId: mintWireMessageId({ nowMs }).id,
    startedAtMs: nowMs,
  };
}

export function initialSandboxTurnMetadata(
  turn: PreparedInitialSandboxTurn,
): Record<string, unknown> {
  return {
    token: turn.token,
    state: 'delivering',
    runtimeSessionId: null,
    opencodeSessionId: null,
    messageId: turn.messageId,
    startedAtMs: turn.startedAtMs,
  };
}

function parseStoredSandboxTurn(value: unknown, expectedToken?: string): StoredSandboxTurn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const turn = value as Record<string, unknown>;
  if (
    (turn.state !== 'delivering' && turn.state !== 'active') ||
    typeof turn.token !== 'string' ||
    !turn.token.trim()
  ) {
    return null;
  }
  if (expectedToken !== undefined && turn.token !== expectedToken) return null;
  const runtimeSessionId = storedTurnRuntimeSessionId(turn);
  return {
    token: turn.token,
    state: turn.state,
    runtimeSessionId: typeof runtimeSessionId === 'string' ? runtimeSessionId : '',
    messageId: typeof turn.messageId === 'string' ? turn.messageId : null,
    startedAtMs:
      typeof turn.startedAtMs === 'number' && Number.isFinite(turn.startedAtMs)
        ? turn.startedAtMs
        : null,
  };
}

/**
 * The sandbox states in which stored turn metadata still means anything.
 *
 * Metadata outlives the runtime: a stopped box can keep an `activeTurns` entry
 * for a turn that died with it. Every reader of turn AUTHORITY — the
 * `GET .../turn` endpoint and the inbox admission gate — must apply the same
 * status filter, or the endpoint and the gate disagree about whether a session
 * is busy. Shared here so they cannot drift.
 */
export const RUNNING_SANDBOX_STATUSES: ReadonlySet<string> = new Set(['active', 'provisioning']);
/**
 * Read every control-plane-minted turn the reaper may repair or renew, keyed
 * by its own token in the `activeTurns` object so one failed or queued prompt
 * cannot erase lifecycle authority for another turn.
 */
export function storedSandboxTurns(
  metadata: Record<string, unknown> | null | undefined,
): StoredSandboxTurn[] {
  const turns: StoredSandboxTurn[] = [];
  const values = metadata?.activeTurns;
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    for (const [token, value] of Object.entries(values as Record<string, unknown>)) {
      const turn = parseStoredSandboxTurn(value, token);
      if (turn) turns.push(turn);
    }
  }
  return turns;
}
/**
 * The runtime session and client-minted message a turn-start request names.
 * `noReply` persists the message and starts no loop: there is no turn to
 * track, and no idle relay will ever arrive to close one. Such a POST skips
 * the ledger's live-turn serialization; the inbox admission gate is what keeps
 * it out of a live turn. A malformed body leaves the identity session-scoped;
 * the delivery token still provides CAS safety.
 */
export function extractTurnIdentity(
  path: string,
  body: ArrayBuffer | undefined,
): SandboxTurnIdentity | null {
  const request = classifyRuntimeRequest('POST', path);
  if (request.kind !== 'turn-start') return null;
  const { messageId, noReply } = turnStartBodyFields(body);
  if (noReply) return null;
  return { runtimeSessionId: request.runtimeSessionId, messageId };
}

export interface SandboxTurnStart extends SandboxTurnIdentity {
  token: string;
}
export type RuntimeTurnAdoption = 'adopted' | 'open_turn_exists' | 'known_message' | 'no_box';
/**
 * Apply terminal evidence. A retryable error is not terminal. When both sides
 * know the OpenCode user message ID, a delayed event may clear only that turn.
 * Older daemons and command turns have no message ID; they remain scoped to the
 * root OpenCode session for rolling-deploy compatibility.
 */
export type SandboxTurnCompletionOutcome =
  | 'closed'
  | 'already_closed'
  | 'identity_mismatch'
  | 'no_active_turn'
  | 'non_terminal';
export interface SandboxTurnCompletionResult {
  outcome: SandboxTurnCompletionOutcome;
  activeTurnCount: number;
  closedTurnCount: number;
}
export function turnCompletionAllowsQueuePromotion(
  result: Pick<SandboxTurnCompletionResult, 'outcome'>,
): boolean {
  return (
    result.outcome === 'closed' ||
    result.outcome === 'already_closed' ||
    result.outcome === 'no_active_turn'
  );
}

/**
 * HOW a turn ended, and the only field that separates "the model finished" from
 * "the runtime disappeared mid-turn". Every value has a real writer:
 *
 * - `completed`    the model finished — session.idle, or the daemon naming this
 *                  turn's own completed assistant message.
 * - `failed`       a terminal, non-retryable model error, or a turn the control
 *                  plane had to force-close because nothing was writing it.
 * - `abandoned`    delivery never reached OpenCode (upstream 4xx/5xx, an
 *                  unreachable sandbox, the daemon's `turn_abandoned`, or a
 *                  daemon that cannot find the client-minted message at all).
 * - `runtime_gone` the box parked or the daemon stopped answering while the
 *                  turn was still open. Control-plane-only: a sandbox is never
 *                  allowed to name this one about itself.
 * - `unknown`      the turn is provably over and no observer could say how — an
 *                  agent build that predates `turn_end`, or an OpenCode state
 *                  its messages do not classify. It exists so the four values
 *                  above stay true; a guess would make every one of them
 *                  unreliable.
 */
export type SessionTurnEndReason =
  | 'completed'
  | 'runtime_gone'
  | 'failed'
  | 'abandoned'
  | 'unknown';

/**
 * Ledger writes are OBSERVATION, never authority. `activeTurns` stays the
 * single lifecycle truth; a failed ledger write must never fail a prompt, a
 * turn acceptance, or a reaper pass. Log and continue.
 */
export async function recordTurnLedger(query: SQL, context: string): Promise<void> {
  try {
    await execute(query);
  } catch (error) {
    console.warn(
      `[turn-ledger] ${context} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

interface SessionTurnOwner {
  sessionId: string;
  sandboxId: string;
  projectId: string;
  accountId: string;
}

export const ledgerText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value : null;

/** Identity the ledger needs, read back from the authority write itself. */
export function ledgerIdentity(row: Record<string, unknown> | undefined): SessionTurnOwner | null {
  const sessionId = ledgerText(row?.session_id);
  const sandboxId = ledgerText(row?.sandbox_id);
  const projectId = ledgerText(row?.project_id);
  const accountId = ledgerText(row?.account_id);
  if (!sessionId || !sandboxId || !projectId || !accountId) return null;
  return { sessionId, sandboxId, projectId, accountId };
}

/** One turn the authority write just erased, as the ledger has to record it. */
interface EndedTurnRecord {
  token: string;
  runtimeSessionId: string | null;
  messageId: string | null;
  startedAtMs: number | null;
}

function toEndedTurnRecord(value: unknown): EndedTurnRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const turn = value as Record<string, unknown>;
  const token = ledgerText(turn.token);
  if (!token) return null;
  const startedAtMs = Number(turn.startedAtMs);
  return {
    token,
    runtimeSessionId: ledgerText(storedTurnRuntimeSessionId(turn)),
    messageId: ledgerText(turn.messageId),
    startedAtMs: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : null,
  };
}

/**
 * The turns the authority write aggregated. `jsonb_agg` reaches this process as
 * a parsed value on some drivers and as JSON text on others, so accept both
 * rather than let a driver detail silence the ledger.
 */
export function endedLedgerTurns(value: unknown): EndedTurnRecord[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map(toEndedTurnRecord).filter((turn): turn is EndedTurnRecord => turn !== null);
}

/** What the daemon said went wrong, as `routes/turn-stream.ts` reads it off an end frame. */
export interface SandboxTurnEndError {
  name?: string;
  message?: string;
  isRetryable?: boolean;
}

/** The part of an end error the ledger keeps. Null when nobody named the failure. */
export interface SessionTurnEndErrorRecord {
  name: string | null;
  message: string | null;
}

const END_ERROR_MESSAGE_MAX_CHARS = 2000;

// An abort is the EFFECT of whatever stopped the turn, not its cause: a Stop
// click, a memory guard and a respawn all surface as one of these. A later end
// frame that names the cause replaces it; nothing replaces a named cause.
export const ABORT_END_ERROR_NAMES = ['MessageAbortedError', 'AbortError'];

// A STOP SOMEBODY ASKED FOR IS NOT A FAILURE, and the end frame cannot say so:
// a requested stop and an abort nobody asked for both reach the ledger as the
// same OpenCode "Aborted" frame. So the request is stamped on the OPEN turn,
// BEFORE the abort can reach OpenCode, at every place a request passes through
// the control plane:
//
//   UserStop        - `POST .../prompts/hold {held:true}`, the first request of
//                     a web, SDK or mobile Stop. Its settle
//                     (`inbox-hold-settle.ts`) can abort the box before the
//                     client's own abort arrives.
//                   - every client abort (web, mobile, SDK, CLI): an OpenCode
//                     `POST /session/:id/abort` through the sandbox proxy.
//                   - `abortRuntimeTurn(…, { requestedStop: true })`: the hold
//                     settle's re-abort, and Slack/Teams Stop.
//   QueueInterrupt  a prompt sent into a busy session arms an interrupt at the
//                   next tool boundary (`armQuickQueueInterrupt`).
//
// CLOSED on purpose, like `STOP_REASONS`: a reader hides these turns from the
// failure list, so a free-text value would hide a real failure silently.
export const REQUESTED_STOP_NAMES = ['UserStop', 'QueueInterrupt'] as const;
export type RequestedStopName = (typeof REQUESTED_STOP_NAMES)[number];

export function isRequestedStopName(name: string | null | undefined): name is RequestedStopName {
  return (REQUESTED_STOP_NAMES as readonly string[]).includes(name ?? '');
}

/**
 * Is this `end_error` already a cause the unidentified-cause recorder must not
 * replace? An abort (`ABORT_END_ERROR_NAMES`) is the EFFECT of whatever stopped
 * the turn, never its cause, so it is the only replaceable name. A requested
 * stop (`REQUESTED_STOP_NAMES`) and every other named cause are protected.
 *
 * The JS and SQL forms below are mirrors over the same `ABORT_END_ERROR_NAMES`:
 * the recorder's rewrite predicates and the ledger upsert CASE all read one
 * definition, so their precedence cannot drift.
 */
export function isProtectedEndError(name: string | null | undefined): boolean {
  return !!name && !(ABORT_END_ERROR_NAMES as readonly string[]).includes(name);
}

/** SQL form of `isProtectedEndError`, over an `end_error` jsonb column. */
function protectedEndErrorPredicate(column: SQL): SQL {
  const abortNames = sql.join(
    ABORT_END_ERROR_NAMES.map((name) => sql`${name}`),
    sql`, `,
  );
  return sql`(${column} IS NOT NULL
    AND coalesce(${column}->>'name', '') NOT IN (${abortNames}))`;
}

/** Which open turns a request applies to. Omitted fields match every turn. */
export interface RequestedStopScope {
  opencodeSessionId?: string | null;
  messageId?: string | null;
}

/**
 * Stamp a requested stop on the session's open turns. A row whose OpenCode
 * session is not recorded yet still matches: it cannot be proved to be another
 * session's turn, and an unmarked stop reads as a failure.
 */
export async function markTurnStopRequested(
  sessionId: string,
  name: RequestedStopName,
  scope: RequestedStopScope = {},
): Promise<void> {
  const mark = JSON.stringify({ name, message: null });
  await recordTurnLedger(
    sql`UPDATE kortix.session_turns
           SET end_error = ${mark}::jsonb,
               updated_at = now()
         WHERE session_id = ${sessionId}
           AND state <> 'ended'
           AND (${scope.opencodeSessionId ?? null}::text IS NULL
             OR opencode_session_id IS NULL
             OR opencode_session_id = ${scope.opencodeSessionId ?? null})
           AND (${scope.messageId ?? null}::text IS NULL
             OR message_id = ${scope.messageId ?? null})`,
    `mark ${name} ${sessionId}`,
  );
}

/** Withdraw a request that will not happen (a disarmed queue interrupt). */
export async function clearTurnStopRequest(
  sessionId: string,
  name: RequestedStopName,
): Promise<void> {
  await recordTurnLedger(
    sql`UPDATE kortix.session_turns
           SET end_error = NULL,
               updated_at = now()
         WHERE session_id = ${sessionId}
           AND state <> 'ended'
           AND end_error->>'name' = ${name}`,
    `clear ${name} ${sessionId}`,
  );
}

/**
 * What the reaper saw when it had to close a turn whose own end frame never
 * arrived. The message is shown to the user as the reason, so it is copy.
 */
export const REAPER_TURN_CAUSES = {
  /** The daemon said no turn is running, yet OpenCode held the reply open. */
  huskFinalized: {
    name: 'TurnHuskFinalized',
    message: 'The agent stopped responding in the middle of this turn, so Kortix closed it.',
  },
  /** The daemon said the turn failed; the frame that said why was lost. */
  runtimeFailed: {
    name: 'RuntimeTurnFailed',
    message: 'The sandbox reported that this turn failed, but the error did not reach Kortix.',
  },
  /**
   * The provider reported the box `stopped` while a turn was open and nothing
   * Kortix did asked for that (`sandbox-state-sync.ts` `providerOriginated`).
   * The provider names no cause of its own (Platinum's own stop reason is not
   * yet readable by the control plane — see the memory-guard/runtime-gone-
   * recovery learning), so this is deliberately generic rather than false.
   */
  boxStoppedMidTurn: {
    name: 'SandboxStoppedMidTurn',
    message: 'The sandbox stopped unexpectedly while this turn was running.',
  },
  /** Same box-gone event, but an unattended session's turn is being resumed
   *  automatically — see `session-lifecycle/unattended-runtime-recovery.ts`. */
  boxStoppedMidTurnRecovering: {
    name: 'SandboxStoppedMidTurnRecovering',
    message: 'The sandbox stopped unexpectedly. Kortix restarted it and resumed this turn.',
  },
} as const satisfies Record<string, SessionTurnEndErrorRecord>;

/** How long after a bare abort a cause with no turn identity may still claim it. */
export const UNIDENTIFIED_CAUSE_WINDOW_MS = 60_000;

export type UnidentifiedTurnCauseOutcome = 'refined_ended' | 'marked_open' | 'none';

/**
 * Attach a named cause to the turn it stopped when the frame does not name
 * that turn.
 *
 * A daemon built before the memory guard named its turn sends the cause with
 * no `turn_message_id` and `error_retryable: true`. `completeSandboxTurn`
 * drops that frame as `non_terminal`, and the UI showed "No reason was
 * reported" under a turn the guard stopped (prod 2026-09-22). Sandboxes keep
 * their daemon until they restart, so the control plane must accept the frame.
 *
 * The guard aborts first and reports second, so the abort usually closes the
 * turn before the cause arrives. In order:
 *  1. The newest turn of this OpenCode session that ended with a bare abort
 *     in the last `windowMs` gets the cause. This beats an open turn: the
 *     next prompt can start before the cause lands.
 *  2. Otherwise the open turn holds the cause. The abort that follows keeps
 *     it; a completion drops it.
 * Only a bare abort (`ABORT_END_ERROR_NAMES`) is rewritten: a requested stop or
 * another named cause is never. `protectedEndErrorPredicate` is the one
 * precedence this path and the ledger CASE read.
 */
export async function recordUnidentifiedTurnCause(
  sessionId: string,
  opencodeSessionId: string | null | undefined,
  cause: SessionTurnEndErrorRecord,
  windowMs = UNIDENTIFIED_CAUSE_WINDOW_MS,
): Promise<UnidentifiedTurnCauseOutcome> {
  const causeJson = JSON.stringify(cause);
  const sameRoot = sql`(${opencodeSessionId ?? null}::text IS NULL
                         OR t.opencode_session_id IS NULL
                         OR t.opencode_session_id = ${opencodeSessionId ?? null})`;
  const refined = normalizeRows(
    await execute(sql`
      UPDATE kortix.session_turns
         SET end_error = ${causeJson}::jsonb, updated_at = now()
       WHERE turn_token = (
         SELECT t.turn_token
           FROM kortix.session_turns t
          WHERE t.session_id = ${sessionId}
            AND t.state = 'ended'
            AND t.end_reason = 'failed'
            AND t.ended_at > now() - make_interval(secs => ${secs(windowMs)})
            AND ${sameRoot}
          ORDER BY t.ended_at DESC
          LIMIT 1)
         AND NOT ${protectedEndErrorPredicate(sql`end_error`)}
      RETURNING turn_token`),
  );
  if (refined && refined.length > 0) return 'refined_ended';
  const marked = normalizeRows(
    await execute(sql`
      UPDATE kortix.session_turns t
         SET end_error = ${causeJson}::jsonb, updated_at = now()
       WHERE t.session_id = ${sessionId}
         AND t.state <> 'ended'
         AND ${sameRoot}
         AND NOT ${protectedEndErrorPredicate(sql`t.end_error`)}
      RETURNING t.turn_token`),
  );
  return marked && marked.length > 0 ? 'marked_open' : 'none';
}

export function endErrorRecord(
  status: 'idle' | 'error',
  error?: SandboxTurnEndError | null,
): SessionTurnEndErrorRecord | null {
  if (status !== 'error') return null;
  const name = error?.name?.trim() || null;
  const message = error?.message?.trim().slice(0, END_ERROR_MESSAGE_MAX_CHARS) || null;
  return name || message ? { name, message } : null;
}

/**
 * Settle one ended turn per token, creating the row when the turn never got
 * one.
 *
 * UPSERT, not UPDATE, for two reasons that both leave permanent phantoms
 * otherwise:
 *  - a boot turn is written straight into `session_sandboxes.metadata` by
 *    initialSandboxTurnMetadata and can end before it is ever accepted, so it
 *    has no row to update;
 *  - `beginSandboxTurn` writes its row in a second round trip AFTER the
 *    authority write, so a fast terminal end can settle a token whose INSERT
 *    has not landed yet. Writing the ended row here means that late INSERT
 *    loses its `ON CONFLICT (turn_token) DO NOTHING` and the turn stays ended.
 *
 * One explicit VALUES row per turn, never a bound array: this driver renders a
 * bound JS array as a record and Postgres rejects `cannot cast type record to
 * text[]`. Every value is still a bound parameter.
 */

export function endedTurnLedger(
  owner: SessionTurnOwner,
  turns: EndedTurnRecord[],
  reason: SessionTurnEndReason,
  endError: SessionTurnEndErrorRecord | null = null,
  /**
   * `endError` is the control plane's own inference (the reaper), not the
   * sandbox's report: it fills an empty `end_error` and never replaces one.
   */
  endErrorIsFallback = false,
): SQL {
  const endErrorJson = endError ? JSON.stringify(endError) : null;
  // A mark held on the open turn — a requested stop, or a cause that arrived
  // before its abort (`recordUnidentifiedTurnCause`) — survives only the abort
  // it caused. A turn that completed drops it, and a NAMED cause in the end
  // frame always wins: the mark must never hide a failure. `protectedEndError`
  // is the same precedence `recordUnidentifiedTurnCause` reads, so the two
  // cannot drift.
  const values = sql.join(
    turns.map(
      (turn) => sql`(${turn.token}, ${owner.sessionId}, ${owner.sandboxId}::uuid,
          ${owner.projectId}::uuid, ${owner.accountId}::uuid,
          ${turn.runtimeSessionId}, ${turn.messageId}, 'ended', ${reason},
          ${endErrorJson}::jsonb,
          ${
            turn.startedAtMs === null
              ? sql`now()`
              : sql`${new Date(turn.startedAtMs).toISOString()}::timestamptz`
          },
          now(), now(), now())`,
    ),
    sql`, `,
  );
  return sql`INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id,
         opencode_session_id, message_id, state, end_reason, end_error, started_at,
         ended_at, created_at, updated_at)
      VALUES ${values}
      ON CONFLICT (turn_token) DO UPDATE SET
            state = 'ended',
            end_reason = EXCLUDED.end_reason,
            end_error = CASE
              WHEN ${endErrorIsFallback}
                THEN coalesce(kortix.session_turns.end_error, EXCLUDED.end_error)
              WHEN EXCLUDED.end_reason = 'failed'
               AND ${protectedEndErrorPredicate(sql`kortix.session_turns.end_error`)}
               AND NOT ${protectedEndErrorPredicate(sql`EXCLUDED.end_error`)}
                THEN kortix.session_turns.end_error
              ELSE EXCLUDED.end_error
            END,
            ended_at = now(),
            opencode_session_id = coalesce(kortix.session_turns.opencode_session_id,
                                           EXCLUDED.opencode_session_id),
            message_id = coalesce(kortix.session_turns.message_id, EXCLUDED.message_id),
            updated_at = now()
      WHERE kortix.session_turns.state <> 'ended'`;
}

/**
 * Settle every still-open ledger row of one sandbox.
 *
 * The stop writer (reaping/sandbox-state-sync.ts) erases `activeTurn` /
 * `activeTurns` in one statement, so after it commits no token-scoped settle
 * can ever fire again — the CAS every other path uses needs the metadata entry
 * that the stop just deleted. This query is keyed by sandbox instead, and runs
 * in the SAME transaction as that erasure. `session_turns_open_idx` is the
 * partial index on exactly this predicate.
 *
 * `cause` is what the STOP WRITER already knows about why the box went away
 * (see `REAPER_TURN_CAUSES.boxStoppedMidTurn*`) — never the sandbox's own
 * report, so it fills an empty `end_error` only and never replaces a real one,
 * same rule as `recordUnidentifiedTurnCause`.
 */
export function settleOpenSandboxTurnsQuery(
  sandboxId: string,
  reason: SessionTurnEndReason,
  cause: SessionTurnEndErrorRecord | null = null,
): SQL {
  const causeJson = cause ? JSON.stringify(cause) : null;
  return sql`UPDATE kortix.session_turns
                SET state = 'ended', end_reason = ${reason}, ended_at = now(), updated_at = now()
                    ${
                      causeJson
                        ? sql`, end_error = CASE WHEN NOT ${protectedEndErrorPredicate(sql`end_error`)} THEN ${causeJson}::jsonb ELSE end_error END`
                        : sql``
                    }
              WHERE sandbox_id = ${sandboxId}::uuid
                AND state <> 'ended'`;
}

/** The subset of a drizzle transaction this module needs to settle inside one. */
export interface SandboxTurnLedgerTransaction {
  execute(query: SQL): Promise<unknown>;
  transaction<T>(fn: (savepoint: SandboxTurnLedgerTransaction) => Promise<T>): Promise<T>;
}

/**
 * Run the stop's settle INSIDE the caller's transaction, but INSIDE a savepoint.
 *
 * Two rules meet here and both have to hold:
 *  - the settle must be durable with the stop, because the same transaction
 *    erases the turn authority every token-scoped settle CASes against, so
 *    after it commits nothing can ever close those rows;
 *  - the settle must never fail the stop. By the time a stop writer reaches
 *    this point the PROVIDER BOX IS ALREADY OFF (stop-box.ts and
 *    parkEstablishedRuntime both stop it first) and its compute window is
 *    already closed. A statement error here without a savepoint aborts the whole
 *    transaction, leaving `session_sandboxes.status = 'active'` and
 *    `project_sessions.status = 'running'` against a dead box — and every retry
 *    fails the same way while the cause lasts. Causes are real and shared, not
 *    exotic: a lock or statement timeout on this table, an API rollout ahead of
 *    migrate-db, a later migration holding ACCESS EXCLUSIVE.
 *
 * The savepoint makes the failure cost exactly the observation it was: the
 * ledger keeps rows the reaper's own backstop then settles on a later pass
 * (reaping/box-reaper.ts), and the stop commits.
 */
export async function settleOpenSandboxTurns(
  tx: SandboxTurnLedgerTransaction,
  sandboxId: string,
  reason: SessionTurnEndReason,
  cause: SessionTurnEndErrorRecord | null = null,
): Promise<void> {
  try {
    // A nested drizzle transaction IS `savepoint` / `rollback to savepoint`.
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(settleOpenSandboxTurnsQuery(sandboxId, reason, cause));
    });
  } catch (error) {
    console.error(
      `[turn-ledger] stop settle failed for ${sandboxId} (${reason}); the stop still commits:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** The backstop statement, built once so the index test EXPLAINs what ships. */
export function settleOrphanedSandboxTurnsQuery(): SQL {
  return sql`UPDATE kortix.session_turns t
                SET state = 'ended',
                    end_reason = coalesce(t.end_reason, 'runtime_gone'),
                    ended_at = coalesce(t.ended_at, now()),
                    updated_at = now()
              WHERE t.state <> 'ended'
                AND NOT EXISTS (
                  SELECT 1
                    FROM kortix.session_sandboxes s
                   WHERE s.sandbox_id = t.sandbox_id
                     AND s.status IN ('active', 'provisioning'))`;
}

/**
 * THE BACKSTOP: close every ledger row still open on a sandbox that is no
 * longer running, platform-wide.
 *
 * Every writer settles the rows it erases authority for, and the two-round-trip
 * writers refuse to open a row once a stop has committed. This pass exists
 * because "every row reaches ended" must be a property of the SYSTEM, not a sum
 * of arguments about five call sites: a stop's savepoint-bounded settle can roll
 * back, a row can predate this code, and a `session_sandboxes` row can be
 * deleted out from under its history. Any of those leaves a row that answers
 * "is a turn running?" with a permanent yes.
 *
 * `runtime_gone` for a row with no reason of its own: whatever was open when the
 * box stopped running ended because the runtime went away. A row that already
 * carries a reason keeps it — this pass closes histories, it never rewrites one.
 *
 * `session_turns_open_idx` is the partial index over exactly the rows this
 * scans, so the cost is proportional to what is still open, not to the retained
 * history.
 */
export async function settleOrphanedSandboxTurns(): Promise<number> {
  try {
    const result = await execute(settleOrphanedSandboxTurnsQuery());
    return (result as { count?: number } | null)?.count ?? 0;
  } catch (error) {
    console.warn(
      '[turn-ledger] orphan settle failed:',
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

/**
 * A second end frame for a turn that is already closed may still be the only one
 * that says WHY. A session on 2026-09-18: OpenCode's own "Aborted" frame
 * closed the turn 476 ms before the memory guard's frame named the cause. Same
 * identity match as `wasSandboxTurnAlreadyClosed`; touches `failed` rows only,
 * and only to replace a missing or abort-only error with a named cause.
 */
export function refineEndedTurnError(
  sessionId: string,
  identity: Partial<SandboxTurnIdentity>,
  endError: SessionTurnEndErrorRecord,
): SQL {
  return sql`
    UPDATE kortix.session_turns t
       SET end_error = ${JSON.stringify(endError)}::jsonb,
           updated_at = now()
     WHERE t.session_id = ${sessionId}
       AND t.message_id = ${identity.messageId ?? null}
       AND t.state = 'ended'
       AND t.end_reason = 'failed'
       AND (${identity.runtimeSessionId ?? null}::text IS NULL
         OR t.opencode_session_id IS NULL
         OR t.opencode_session_id = ${identity.runtimeSessionId ?? null})
       AND NOT ${protectedEndErrorPredicate(sql`t.end_error`)}`;
}

/**
 * A later genuine completion for a message the ledger already closed as
 * `abandoned` proves the abandon was premature: delivery DID reach OpenCode
 * and the turn ran, but whatever declared it abandoned (the daemon's own
 * boot-time delivery check, or a reaper reconciliation) observed that too
 * early and reported a false negative. `abandonSandboxTurn` DELETES the
 * `activeTurns` record it closes, so nothing short of this rewrite can ever
 * correct the row once that happens — the real completion arrives with
 * `turns.length === 0` (no metadata entry left to close) and, without this,
 * `already_closed` returns silently and the ledger keeps the wrong verdict
 * forever (PROD 2026-09-26: 73 sessions, 15/19 checked had actually
 * completed).
 *
 * Exact identity match only, like `refineEndedTurnError` — never a fallback
 * — so unrelated evidence can never repaint a genuinely abandoned turn (one
 * that really never reached OpenCode) as completed. Scoped to
 * `end_reason = 'abandoned'` rows only: a `failed`/`completed`/`runtime_gone`
 * row already carries a real verdict from evidence that observed the turn in
 * progress, which this must never overwrite.
 */
export function reviveAbandonedTurnOnCompletion(
  sessionId: string,
  identity: Partial<SandboxTurnIdentity>,
  endReason: 'completed' | 'failed',
  endError: SessionTurnEndErrorRecord | null,
): SQL {
  const endErrorJson = endError ? JSON.stringify(endError) : null;
  return sql`
    UPDATE kortix.session_turns t
       SET end_reason = ${endReason},
           end_error = ${endErrorJson}::jsonb,
           updated_at = now()
     WHERE t.session_id = ${sessionId}
       AND t.message_id = ${identity.messageId ?? null}
       AND t.state = 'ended'
       AND t.end_reason = 'abandoned'
       AND (${identity.runtimeSessionId ?? null}::text IS NULL
         OR t.opencode_session_id IS NULL
         OR t.opencode_session_id = ${identity.runtimeSessionId ?? null})`;
}

export async function wasSandboxTurnAlreadyClosed(
  sessionId: string,
  identity?: Partial<SandboxTurnIdentity> | null,
): Promise<boolean> {
  if (!identity?.messageId) return false;
  const result = await execute(sql`
    SELECT EXISTS(
      SELECT 1
        FROM kortix.session_turns t
       WHERE t.session_id = ${sessionId}
         AND t.message_id = ${identity.messageId}
         AND t.state = 'ended'
         AND (${identity.runtimeSessionId ?? null}::text IS NULL
           OR t.opencode_session_id IS NULL
           OR t.opencode_session_id = ${identity.runtimeSessionId ?? null})
    ) AS already_ended`);
  return normalizeRows(result)?.[0]?.already_ended === true;
}
