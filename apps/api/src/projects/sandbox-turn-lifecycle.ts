/**
 * Durable active-turn authority for sandbox lifecycle renewal.
 *
 * `deadline_at` answers when an idle sandbox stops. It cannot also answer
 * whether an OpenCode turn is active. A local tool can run without an LLM call
 * for longer than one deadline grant. This module stores that separate fact in
 * `session_sandboxes.metadata.activeTurns`.
 *
 * Only the control plane can create a turn record. Promotion requires either
 * the API's accepted upstream response or daemon evidence tied to that record's
 * opaque token. Terminal evidence removes the record and shortens the deadline.
 * Renewal requires a fresh control-plane observation of the exact OpenCode
 * turn. A durable record cannot renew itself when OpenCode is unreachable.
 */

import { randomUUID } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import type { DeadlineTarget } from './sandbox-deadline';
import {
  idleGraceMs,
  isTerminalTurnEnd,
  sandboxStopClaimLeaseMs,
  turnDeliveryGraceMs,
  turnGrantMs,
} from './sandbox-deadline-policy';
import { confirmInboxPromptConsumed } from './session-lifecycle/consumption';
import { mintWireMessageId } from './wire-message-id';

export interface SandboxTurnIdentity {
  opencodeSessionId: string;
  messageId: string | null;
}

export interface SandboxTurnStart extends SandboxTurnIdentity {
  token: string;
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
   * When the control plane minted this turn. Null for a legacy `activeTurn`
   * record written before `activeTurns` existed — those carry no start instant,
   * and inventing one would make a reader trust a number nobody measured.
   */
  startedAtMs: number | null;
}

let databasePromise: Promise<typeof import('../shared/db')['db']> | null = null;
function database() {
  databasePromise ??= import('../shared/db').then((module) => module.db);
  return databasePromise;
}

async function execute(query: SQL) {
  return (await database()).execute(query);
}

const secs = (ms: number) => Math.round(ms / 1000);

function targetPredicate(target: DeadlineTarget) {
  if ('sandboxId' in target) return sql`s.sandbox_id = ${target.sandboxId}::uuid`;
  if ('sessionId' in target) return sql`s.session_id = ${target.sessionId}`;
  return sql`s.external_id = ${target.externalId}`;
}

function normalizeRows(result: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : null;
}

function jsonbObject(value: SQL): SQL {
  return sql`CASE
    WHEN jsonb_typeof(${value}) = 'object' THEN ${value}
    ELSE '{}'::jsonb
  END`;
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
async function recordTurnLedger(query: SQL, context: string): Promise<void> {
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

const ledgerText = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

/** Identity the ledger needs, read back from the authority write itself. */
function ledgerIdentity(row: Record<string, unknown> | undefined): SessionTurnOwner | null {
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
  opencodeSessionId: string | null;
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
    opencodeSessionId: ledgerText(turn.opencodeSessionId),
    messageId: ledgerText(turn.messageId),
    startedAtMs: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : null,
  };
}

/**
 * The turns the authority write aggregated. `jsonb_agg` reaches this process as
 * a parsed value on some drivers and as JSON text on others, so accept both
 * rather than let a driver detail silence the ledger.
 */
function endedLedgerTurns(value: unknown): EndedTurnRecord[] {
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
function endedTurnLedger(
  owner: SessionTurnOwner,
  turns: EndedTurnRecord[],
  reason: SessionTurnEndReason,
): SQL {
  const values = sql.join(
    turns.map(
      (turn) => sql`(${turn.token}, ${owner.sessionId}, ${owner.sandboxId}::uuid,
          ${owner.projectId}::uuid, ${owner.accountId}::uuid,
          ${turn.opencodeSessionId}, ${turn.messageId}, 'ended', ${reason},
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
         opencode_session_id, message_id, state, end_reason, started_at,
         ended_at, created_at, updated_at)
      VALUES ${values}
      ON CONFLICT (turn_token) DO UPDATE SET
            state = 'ended',
            end_reason = EXCLUDED.end_reason,
            ended_at = now(),
            opencode_session_id = coalesce(kortix.session_turns.opencode_session_id,
                                           EXCLUDED.opencode_session_id),
            message_id = coalesce(kortix.session_turns.message_id, EXCLUDED.message_id),
            updated_at = now()
      WHERE kortix.session_turns.state <> 'ended'`;
}

/**
 * The rows a ledger INSERT is allowed to create a turn from: the sandbox that
 * still holds this exact token's authority, locked.
 *
 * Both writers that OPEN a ledger row do it in a SECOND round trip after their
 * authority write, and a stop can commit in that gap. The stop erases
 * `activeTurns` and settles the sandbox's open rows in one transaction, so a
 * row created after it commits can never be closed by anything: every
 * token-scoped settle CASes against the entry the stop deleted, and the
 * sandbox-scoped one has already run. That row would claim a turn is running
 * for ever on a parked box.
 *
 * `FOR UPDATE` is what closes the window rather than narrowing it. A plain
 * predicate reads its own snapshot and happily passes while the stop is
 * mid-commit; the lock makes this statement WAIT for that transaction and then
 * re-evaluate against the row it wrote, so the two orderings are the only two
 * outcomes: the INSERT lands first and the stop settles it, or the stop lands
 * first and the INSERT writes nothing. Lock order is unchanged
 * (session_sandboxes, then session_turns), so this adds no deadlock edge.
 */
function openableTurnOwner(sandboxId: string, token: string): SQL {
  return sql`SELECT s.session_id, s.sandbox_id, s.project_id, s.account_id
               FROM kortix.session_sandboxes s
              WHERE s.sandbox_id = ${sandboxId}::uuid
                AND s.status IN ('active', 'provisioning')
                AND (
                  s.metadata->'activeTurns'->${token} IS NOT NULL
                  -- The legacy single-record arm every writer still accepts
                  -- during a rolling deploy. The stop erases it in the same
                  -- statement, so it gates this INSERT identically.
                  OR s.metadata->'activeTurn'->>'token' = ${token})
              FOR UPDATE`;
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
 */
export function settleOpenSandboxTurnsQuery(sandboxId: string, reason: SessionTurnEndReason): SQL {
  return sql`UPDATE kortix.session_turns
                SET state = 'ended', end_reason = ${reason}, ended_at = now(), updated_at = now()
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
): Promise<void> {
  try {
    // A nested drizzle transaction IS `savepoint` / `rollback to savepoint`.
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(settleOpenSandboxTurnsQuery(sandboxId, reason));
    });
  } catch (error) {
    console.error(
      `[turn-ledger] stop settle failed for ${sandboxId} (${reason}); the stop still commits:`,
      error instanceof Error ? error.message : error,
    );
  }
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
    const result = await execute(sql`
      UPDATE kortix.session_turns t
         SET state = 'ended',
             end_reason = coalesce(t.end_reason, 'runtime_gone'),
             ended_at = coalesce(t.ended_at, now()),
             updated_at = now()
       WHERE t.state <> 'ended'
         AND NOT EXISTS (
           SELECT 1
             FROM kortix.session_sandboxes s
            WHERE s.sandbox_id = t.sandbox_id
              AND s.status IN ('active', 'provisioning'))`);
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
  return {
    token: turn.token,
    state: turn.state,
    opencodeSessionId: typeof turn.opencodeSessionId === 'string' ? turn.opencodeSessionId : '',
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
 * Read every control-plane-minted turn the reaper may repair or renew.
 *
 * `activeTurn` remains readable during rolling deployments. New writers use
 * the token-keyed `activeTurns` object so one failed or queued prompt cannot
 * erase lifecycle authority for another turn.
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
  const legacy = parseStoredSandboxTurn(metadata?.activeTurn);
  if (legacy && !turns.some((turn) => turn.token === legacy.token)) turns.push(legacy);
  return turns;
}

/** Rolling-deploy compatibility for callers that still expect one record. */
export function storedSandboxTurn(
  metadata: Record<string, unknown> | null | undefined,
): StoredSandboxTurn | null {
  return storedSandboxTurns(metadata)[0] ?? null;
}

export function deliveringSandboxTurn(
  metadata: Record<string, unknown> | null | undefined,
): StoredSandboxTurn | null {
  return storedSandboxTurns(metadata).find((turn) => turn.state === 'delivering') ?? null;
}

/** Parse the root OpenCode session and client-minted message identity. */
export function extractTurnIdentity(
  path: string,
  body: ArrayBuffer | undefined,
): SandboxTurnIdentity | null {
  const normalized = path.replace(/^\/proxy\/\d+(?=\/)/, '');
  const match = /^\/session\/([^/?#]+)\/(?:prompt_async|message|command|summarize)(?:$|[/?#])/.exec(
    normalized,
  );
  if (!match) return null;

  let messageId: string | null = null;
  if (body?.byteLength) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body)) as { messageID?: unknown };
      if (typeof parsed.messageID === 'string' && parsed.messageID.trim()) {
        messageId = parsed.messageID.trim();
      }
    } catch {
      // The proxy will let OpenCode validate malformed input. Lifecycle identity
      // remains session-scoped and the delivery token still provides CAS safety.
    }
  }
  return { opencodeSessionId: decodeURIComponent(match[1]), messageId };
}

/**
 * Record a control-plane-observed delivery attempt before the upstream call.
 * The short grace covers delivery only. A confirmed response promotes the same
 * token to `active`; a fast terminal event can delete it first and win the CAS.
 */
export async function beginSandboxTurn(
  target: DeadlineTarget,
  turn: SandboxTurnStart,
  graceMs = turnDeliveryGraceMs(),
  observedAtMs?: number,
): Promise<SandboxTurnStartObservation> {
  const metadata = jsonbObject(sql`s.metadata`);
  const activeTurns = jsonbObject(sql`s.metadata->'activeTurns'`);
  const observedAt =
    observedAtMs === undefined
      ? sql`now()`
      : sql`${new Date(observedAtMs).toISOString()}::timestamptz`;
  const result = await execute(sql`
      UPDATE kortix.session_sandboxes s
         SET metadata = jsonb_set(
               ${metadata} - 'lifecycleStopClaim',
               '{activeTurns}',
               ${activeTurns} || jsonb_build_object(
                 ${turn.token}::text,
                 jsonb_build_object(
                   'token', ${turn.token}::text,
                   'state', 'delivering',
                   'opencodeSessionId', ${turn.opencodeSessionId}::text,
                   'messageId', ${turn.messageId}::text,
                   'startedAtMs', floor(extract(epoch from ${observedAt}) * 1000))),
               true),
             deadline_at = GREATEST(
               s.deadline_at,
               ${observedAt} + make_interval(secs => ${secs(graceMs)})),
             updated_at = now()
      WHERE ${targetPredicate(target)}
        AND s.status IN ('active', 'provisioning')
        AND (
          s.metadata->'lifecycleStopClaim' IS NULL
          OR s.metadata->'lifecycleStopClaim'->>'claimedAtMs' !~ '^[0-9]+$'
          OR (s.metadata->'lifecycleStopClaim'->>'claimedAtMs')::bigint
            <= floor(extract(epoch from ${observedAt}) * 1000) - ${sandboxStopClaimLeaseMs()})
      RETURNING s.sandbox_id, s.session_id, s.project_id, s.account_id, true AS granted`);
  const rows = normalizeRows(result);
  if (rows === null) {
    throw new Error('sandbox turn lifecycle write returned an unsupported database result');
  }
  if (rows.length === 0) return 'no_box';

  const owner = ledgerIdentity(rows[0]);
  if (owner) {
    // Identity comes from the guard row, not from the authority write's
    // RETURNING: this INSERT must read the sandbox anyway to prove the token's
    // authority still exists, and one read cannot disagree with itself.
    await recordTurnLedger(
      sql`INSERT INTO kortix.session_turns
            (turn_token, session_id, sandbox_id, project_id, account_id,
             opencode_session_id, message_id, state, started_at, created_at, updated_at)
          SELECT ${turn.token}, owner.session_id, owner.sandbox_id,
                 owner.project_id, owner.account_id,
                 ${turn.opencodeSessionId || null}, ${turn.messageId}, 'delivering',
                 ${observedAt}, now(), now()
            FROM (${openableTurnOwner(owner.sandboxId, turn.token)}) owner
          ON CONFLICT (turn_token) DO NOTHING`,
      `insert delivering ${turn.token}`,
    );
  }
  return 'granted';
}

export type RuntimeTurnAdoption = 'adopted' | 'open_turn_exists' | 'known_message' | 'no_box';

/**
 * Give a BOX-INITIATED turn the same durable authority a delivered prompt gets.
 *
 * Not every turn starts with `POST .../prompts`. OpenCode starts turns of its
 * own — most commonly the synthetic `<pty_exited>` user message it injects when
 * a background pty finishes — and those turns had NO `session_turns` row, no
 * `activeTurns` record, and therefore no deadline grant: `GET .../turn`
 * reported idle for minutes of live streaming, the composer read "not
 * running" over a working session, and a long pty-driven work phase ran on
 * the 15-minute idle tail (live incident 2026-08-20, Essentia session
 * d1b74954). The daemon now relays `turn_begin` when it observes the root go
 * busy; this is that relay's write.
 *
 * Idempotent by construction, so the daemon may relay freely:
 * - a message id the ledger has EVER seen is refused — a late `turn_begin`
 *   must not resurrect a turn the reaper or a turn-end already closed;
 * - any still-open row for this sandbox means authority is already held —
 *   including the normal case where the control plane wrote the record before
 *   delivering the prompt — and nothing is written.
 */
export async function adoptRuntimeSandboxTurn(
  sandboxId: string,
  identity: { opencodeSessionId: string; messageId: string },
): Promise<RuntimeTurnAdoption> {
  const guard = await execute(sql`
    SELECT
      EXISTS(
        SELECT 1 FROM kortix.session_turns t
         WHERE t.sandbox_id = ${sandboxId}::uuid
           AND t.message_id = ${identity.messageId}) AS known,
      EXISTS(
        SELECT 1 FROM kortix.session_turns t
         WHERE t.sandbox_id = ${sandboxId}::uuid
           AND t.state <> 'ended') AS open`);
  const rows = normalizeRows(guard);
  const known = rows?.[0]?.known === true;
  const open = rows?.[0]?.open === true;
  if (known) return 'known_message';
  if (open) return 'open_turn_exists';
  const token = randomUUID();
  const started = await beginSandboxTurn({ sandboxId }, { token, ...identity });
  if (started !== 'granted') return 'no_box';
  const accepted = await acceptSandboxTurn({ sandboxId }, token, identity);
  return accepted ? 'adopted' : 'no_box';
}

/** Promote only the delivery record created by this request. */
export async function acceptSandboxTurn(
  target: DeadlineTarget,
  token: string,
  identity?: Partial<SandboxTurnIdentity> | null,
  grantMs = turnGrantMs(),
): Promise<boolean> {
  const result = await execute(sql`
    UPDATE kortix.session_sandboxes s
       SET metadata = CASE
             WHEN s.metadata->'activeTurns'->${token} IS NOT NULL THEN
               jsonb_set(
                 s.metadata,
                 ARRAY['activeTurns', ${token}]::text[],
                 (s.metadata->'activeTurns'->${token}) || jsonb_strip_nulls(jsonb_build_object(
                   'state', 'active',
                   'opencodeSessionId', ${identity?.opencodeSessionId ?? null}::text,
                   'messageId', ${identity?.messageId ?? null}::text)),
                 false)
             ELSE jsonb_set(
               s.metadata,
               '{activeTurn}',
               (s.metadata->'activeTurn') || jsonb_strip_nulls(jsonb_build_object(
                 'state', 'active',
                 'opencodeSessionId', ${identity?.opencodeSessionId ?? null}::text,
                 'messageId', ${identity?.messageId ?? null}::text)),
               false)
           END,
           deadline_at = GREATEST(
             s.deadline_at,
             now() + make_interval(secs => ${secs(grantMs)})),
           updated_at = now()
     WHERE ${targetPredicate(target)}
       AND s.status IN ('active', 'provisioning')
       AND (
         (s.metadata->'activeTurns'->${token}->>'token' = ${token}
           AND s.metadata->'activeTurns'->${token}->>'state' IN ('delivering', 'active'))
         OR (s.metadata->'activeTurn'->>'token' = ${token}
           AND s.metadata->'activeTurn'->>'state' IN ('delivering', 'active')))
    RETURNING s.sandbox_id, s.session_id, s.project_id, s.account_id, true AS accepted,
              coalesce(s.metadata->'activeTurns'->${token}->>'messageId',
                       s.metadata->'activeTurn'->>'messageId') AS turn_message_id`);
  const rows = normalizeRows(result);
  const accepted = (rows?.length ?? 0) > 0;
  if (!accepted) return false;

  const owner = ledgerIdentity(rows?.[0]);
  if (owner) {
    // UPSERT, not UPDATE: a boot prompt is written straight into
    // `activeTurns` by initialSandboxTurnMetadata and never passes through
    // beginSandboxTurn, so acceptance is that turn's first ledger write — and
    // therefore carries the same guard as beginSandboxTurn's, for the same
    // reason: an INSERT that lands after a stop opens a row nothing can close.
    await recordTurnLedger(
      sql`INSERT INTO kortix.session_turns
            (turn_token, session_id, sandbox_id, project_id, account_id,
             opencode_session_id, message_id, state, started_at, accepted_at, created_at, updated_at)
          SELECT ${token}, owner.session_id, owner.sandbox_id,
                 owner.project_id, owner.account_id,
                 ${identity?.opencodeSessionId ?? null}, ${identity?.messageId ?? null},
                 'active', now(), now(), now(), now()
            FROM (${openableTurnOwner(owner.sandboxId, token)}) owner
          ON CONFLICT (turn_token) DO UPDATE SET
                state = 'active',
                accepted_at = coalesce(kortix.session_turns.accepted_at, now()),
                opencode_session_id = coalesce(EXCLUDED.opencode_session_id, kortix.session_turns.opencode_session_id),
                message_id = coalesce(EXCLUDED.message_id, kortix.session_turns.message_id),
                updated_at = now()
          WHERE kortix.session_turns.state <> 'ended'`,
      `accept ${token}`,
    );
    // ACCEPTANCE IS THE INBOX'S ANSWER. The upstream took the prompt and the
    // ledger now holds an `active` turn keyed to this exact wire id, so the
    // message belongs to the transcript rather than to the queue — whether or
    // not OpenCode has started running it yet.
    //
    // THE ID COMES FROM THE ROW, not only from the argument. The one caller
    // that carries an inbox prompt is the proxy (`preview.ts`'s
    // `acceptTurnLifecycle`), and it passes NO identity — the identity was
    // written durably by `beginSandboxTurn` before the POST, so re-sending it
    // would be re-sending what the record already holds. Reading only the
    // argument made this confirmation dead on every composer prompt, and the
    // row stayed `delivering` until the whole turn ended.
    //
    // Same swallow-and-log shape as the ledger write above, and for the same
    // reason: this is bookkeeping, and a failed confirmation must never fail a
    // turn acceptance.
    await confirmInboxPromptConsumed(
      owner.sessionId,
      identity?.messageId ?? ledgerText(rows?.[0]?.turn_message_id),
    );
  }
  return true;
}

/** Remove a delivery record only when this request still owns it. */
export async function abandonSandboxTurn(target: DeadlineTarget, token: string): Promise<boolean> {
  // The record has to be read BEFORE it is erased: `RETURNING` sees the new row
  // version, so the entry this settle needs is already gone by then. Same
  // FOR UPDATE read-then-write shape as clearSandboxTurn.
  const result = await execute(sql`
    WITH target AS (
      SELECT s.sandbox_id, s.session_id, s.project_id, s.account_id,
             coalesce(s.metadata->'activeTurns'->${token}, s.metadata->'activeTurn') AS turn,
             CASE
               WHEN s.metadata->'activeTurns'->${token} IS NOT NULL THEN
                 jsonb_set(
                   coalesce(s.metadata, '{}'::jsonb),
                   '{activeTurns}',
                   coalesce(s.metadata->'activeTurns', '{}'::jsonb) - ${token},
                   true)
               ELSE coalesce(s.metadata, '{}'::jsonb) - 'activeTurn'
             END AS metadata
        FROM kortix.session_sandboxes s
       WHERE ${targetPredicate(target)}
         AND (
           (s.metadata->'activeTurns'->${token}->>'token' = ${token}
             AND s.metadata->'activeTurns'->${token}->>'state' = 'delivering')
           OR (s.metadata->'activeTurn'->>'token' = ${token}
             AND s.metadata->'activeTurn'->>'state' = 'delivering'))
       FOR UPDATE OF s
    )
    UPDATE kortix.session_sandboxes s
       SET metadata = target.metadata,
           updated_at = now()
      FROM target
     WHERE s.sandbox_id = target.sandbox_id
    RETURNING target.sandbox_id, target.session_id, target.project_id, target.account_id,
              target.turn, true AS abandoned`);
  const rows = normalizeRows(result);
  const abandoned = rows === null || rows.length > 0;
  if (!abandoned) return false;

  // A delivery that never reached OpenCode still happened. Without this the row
  // beginSandboxTurn inserted stays `delivering` forever, and a boot prompt the
  // daemon reports abandoned leaves no history at all.
  const owner = ledgerIdentity(rows?.[0]);
  const turns = endedLedgerTurns(rows?.[0]?.turn);
  if (owner) {
    await recordTurnLedger(
      endedTurnLedger(
        owner,
        turns.length > 0
          ? turns
          : [{ token, opencodeSessionId: null, messageId: null, startedAtMs: null }],
        'abandoned',
      ),
      `abandon ${token}`,
    );
  }
  return true;
}

/**
 * Repair the delivery-to-acceptance gap from provider-neutral OpenCode evidence.
 *
 * `reason` is what the daemon reported about a turn it says is no longer in
 * flight. The default is `abandoned`, not `completed`: this function only ever
 * sees turns still in `delivering`, i.e. turns NOTHING has confirmed reached
 * OpenCode, and the daemon answers `turn_in_flight === false` for a prompt it
 * never received exactly as it does for one that finished.
 */
export async function reconcileSandboxTurnDelivery(
  sandboxId: string,
  token: string,
  observation: SandboxTurnObservation,
  reason: SessionTurnEndReason = 'abandoned',
): Promise<SandboxTurnDeliveryReconciliation> {
  if (observation === 'active') {
    return (await acceptSandboxTurn({ sandboxId }, token)) ? 'active' : 'inactive';
  }
  if (observation === 'terminal') {
    await clearSandboxTurn(sandboxId, token, undefined, reason);
    return 'inactive';
  }
  // Unknown evidence cannot extend authority. The delivery grace was persisted
  // before prompt delivery and remains the only timeout for this state.
  return 'deferred';
}

/**
 * Remove terminal state only when the reaper still owns the observed token.
 * Contract the deadline when this was the final turn. This matches the direct
 * terminal relay and prevents a recovered terminal turn from retaining the
 * prior active-turn grant.
 */
export async function clearSandboxTurn(
  sandboxId: string,
  token: string,
  graceMs = idleGraceMs(),
  reason: SessionTurnEndReason = 'runtime_gone',
): Promise<boolean> {
  const metadata = jsonbObject(sql`s.metadata`);
  const result = await execute(sql`
    WITH target AS (
      SELECT s.sandbox_id, s.session_id, s.project_id, s.account_id,
             coalesce(${metadata}->'activeTurns'->${token}, ${metadata}->'activeTurn') AS turn,
             CASE
               WHEN ${metadata}->'activeTurns'->${token} IS NOT NULL THEN
                 jsonb_set(
                   ${metadata},
                   '{activeTurns}',
                   coalesce(${metadata}->'activeTurns', '{}'::jsonb) - ${token},
                   true)
               ELSE ${metadata} - 'activeTurn'
             END AS metadata
        FROM kortix.session_sandboxes s
       WHERE s.sandbox_id = ${sandboxId}::uuid
         AND s.status = 'active'
         AND (
           ${metadata}->'activeTurns'->${token}->>'token' = ${token}
           OR ${metadata}->'activeTurn'->>'token' = ${token})
       FOR UPDATE OF s
    )
    UPDATE kortix.session_sandboxes s
       SET metadata = target.metadata,
           deadline_at = CASE
             WHEN target.metadata->'activeTurn'->>'state' IN ('delivering', 'active')
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_each(CASE
                     WHEN jsonb_typeof(target.metadata->'activeTurns') = 'object'
                       THEN target.metadata->'activeTurns'
                     ELSE '{}'::jsonb
                   END) remaining
                  WHERE remaining.value->>'state' IN ('delivering', 'active'))
             THEN s.deadline_at
             ELSE LEAST(
               s.deadline_at,
               now() + make_interval(secs => ${secs(graceMs)}))
           END,
           updated_at = now()
      FROM target
     WHERE s.sandbox_id = target.sandbox_id
    RETURNING target.sandbox_id, target.session_id, target.project_id, target.account_id,
              target.turn, true AS cleared`);
  const rows = normalizeRows(result);
  const cleared = (rows?.length ?? 0) > 0;
  if (!cleared) return false;

  const owner = ledgerIdentity(rows?.[0]);
  const turns = endedLedgerTurns(rows?.[0]?.turn);
  if (owner) {
    await recordTurnLedger(
      endedTurnLedger(
        owner,
        turns.length > 0
          ? turns
          : [{ token, opencodeSessionId: null, messageId: null, startedAtMs: null }],
        reason,
      ),
      `clear ${token} (${reason})`,
    );
  }
  return true;
}

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

async function wasSandboxTurnAlreadyClosed(
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
         AND (${identity.opencodeSessionId ?? null}::text IS NULL
           OR t.opencode_session_id IS NULL
           OR t.opencode_session_id = ${identity.opencodeSessionId ?? null})
    ) AS already_ended`);
  return normalizeRows(result)?.[0]?.already_ended === true;
}

export async function completeSandboxTurn(
  sessionId: string,
  status: 'idle' | 'error',
  identity?: Partial<SandboxTurnIdentity> | null,
  error?: { isRetryable?: boolean } | null,
  graceMs = idleGraceMs(),
): Promise<SandboxTurnCompletionResult> {
  if (!isTerminalTurnEnd(status, error)) {
    return { outcome: 'non_terminal', activeTurnCount: 0, closedTurnCount: 0 };
  }
  const metadata = jsonbObject(sql`s.metadata`);
  const result = await execute(sql`
    WITH target AS (
      SELECT s.sandbox_id,
             ${metadata} AS metadata
        FROM kortix.session_sandboxes s
       WHERE s.session_id = ${sessionId}
         AND s.status IN ('active', 'provisioning')
       FOR UPDATE OF s
    ), all_active_turns AS (
      SELECT target.sandbox_id,
             coalesce(entry.value->>'token', entry.key) AS token
        FROM target
        CROSS JOIN LATERAL jsonb_each(CASE
          WHEN jsonb_typeof(target.metadata->'activeTurns') = 'object'
            THEN target.metadata->'activeTurns'
          ELSE '{}'::jsonb
        END) entry
       WHERE entry.value->>'state' IN ('delivering', 'active')
      UNION
      SELECT target.sandbox_id,
             target.metadata->'activeTurn'->>'token' AS token
        FROM target
       WHERE target.metadata->'activeTurn'->>'state' IN ('delivering', 'active')
    ), turn_candidates AS (
      SELECT target.sandbox_id,
             'activeTurns'::text AS source,
             entry.key,
             entry.value->>'token' AS token,
             entry.value
        FROM target
        CROSS JOIN LATERAL jsonb_each(CASE
          WHEN jsonb_typeof(target.metadata->'activeTurns') = 'object'
            THEN target.metadata->'activeTurns'
          ELSE '{}'::jsonb
        END) entry
       WHERE entry.value->>'state' IN ('delivering', 'active')
         AND (entry.value->>'opencodeSessionId' IS NULL
           OR (${identity?.opencodeSessionId ?? null}::text IS NOT NULL
             AND entry.value->>'opencodeSessionId' = ${identity?.opencodeSessionId ?? null}))
      UNION ALL
      SELECT target.sandbox_id,
             'activeTurn'::text AS source,
             'activeTurn'::text AS key,
             target.metadata->'activeTurn'->>'token' AS token,
             target.metadata->'activeTurn' AS value
        FROM target
       WHERE target.metadata->'activeTurn'->>'state' IN ('delivering', 'active')
         AND (target.metadata->'activeTurn'->>'opencodeSessionId' IS NULL
           OR (${identity?.opencodeSessionId ?? null}::text IS NOT NULL
             AND target.metadata->'activeTurn'->>'opencodeSessionId' = ${identity?.opencodeSessionId ?? null}))
    ), exact_matches AS (
      SELECT candidate.sandbox_id, candidate.source, candidate.key, candidate.token,
             candidate.value
        FROM turn_candidates candidate
       WHERE ${identity?.messageId ?? null}::text IS NOT NULL
         AND candidate.value->>'messageId' = ${identity?.messageId ?? null}
    ), fallback_match AS (
      SELECT candidate.sandbox_id, candidate.source, candidate.key, candidate.token,
             candidate.value
        FROM turn_candidates candidate
       WHERE candidate.value->>'messageId' IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM exact_matches exact
            WHERE exact.sandbox_id = candidate.sandbox_id)
       ORDER BY CASE
         WHEN candidate.value->>'startedAtMs' ~ '^[0-9]+$'
           THEN (candidate.value->>'startedAtMs')::bigint
         ELSE 9223372036854775807
       END, candidate.key
       LIMIT 1
    ), selected AS (
      SELECT * FROM exact_matches
      UNION ALL
      SELECT * FROM fallback_match
    ), next_state AS (
      SELECT target.sandbox_id,
             jsonb_set(
               CASE
                 WHEN EXISTS (
                   SELECT 1 FROM selected
                    WHERE selected.sandbox_id = target.sandbox_id
                      AND selected.source = 'activeTurn')
                 THEN target.metadata - 'activeTurn'
                 ELSE target.metadata
               END,
               '{activeTurns}',
               coalesce((
                 SELECT jsonb_object_agg(entry.key, entry.value)
                   FROM jsonb_each(CASE
                     WHEN jsonb_typeof(target.metadata->'activeTurns') = 'object'
                       THEN target.metadata->'activeTurns'
                     ELSE '{}'::jsonb
                   END) entry
                  WHERE NOT EXISTS (
                    SELECT 1 FROM selected
                     WHERE selected.sandbox_id = target.sandbox_id
                       AND selected.source = 'activeTurns'
                       AND selected.key = entry.key)),
                 '{}'::jsonb),
               true) AS metadata,
             (SELECT coalesce(
                       jsonb_agg(jsonb_build_object(
                         'token', selected.token,
                         'opencodeSessionId', selected.value->>'opencodeSessionId',
                         'messageId', selected.value->>'messageId',
                         'startedAtMs', selected.value->>'startedAtMs'))
                         FILTER (WHERE selected.token IS NOT NULL),
                       '[]'::jsonb)
                FROM selected
               WHERE selected.sandbox_id = target.sandbox_id) AS ended_turns
        FROM target
    )
    UPDATE kortix.session_sandboxes s
       SET metadata = next_state.metadata,
           deadline_at = CASE
             WHEN next_state.metadata->'activeTurn'->>'state' IN ('delivering', 'active')
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_each(CASE
                     WHEN jsonb_typeof(next_state.metadata->'activeTurns') = 'object'
                       THEN next_state.metadata->'activeTurns'
                     ELSE '{}'::jsonb
                   END) remaining
                  WHERE remaining.value->>'state' IN ('delivering', 'active'))
             THEN s.deadline_at
             ELSE LEAST(
               s.deadline_at,
               now() + make_interval(secs => ${secs(graceMs)}))
           END,
           updated_at = now()
      FROM next_state
     WHERE s.sandbox_id = next_state.sandbox_id
    RETURNING next_state.ended_turns,
              (SELECT count(*)::int
                 FROM all_active_turns candidate
                WHERE candidate.sandbox_id = next_state.sandbox_id) AS active_turn_count,
              s.session_id, s.sandbox_id, s.project_id, s.account_id,
              true AS completed`);
  const rows = normalizeRows(result);
  if (!rows || rows.length === 0) {
    return { outcome: 'no_active_turn', activeTurnCount: 0, closedTurnCount: 0 };
  }

  // The metadata entry is gone; the ledger row is not. `end_reason` is the only
  // record of HOW the turn ended once activeTurns has forgotten it existed.
  const owner = ledgerIdentity(rows?.[0]);
  const turns = endedLedgerTurns(rows?.[0]?.ended_turns);
  const activeTurnCount = Number(rows[0]?.active_turn_count ?? 0);
  if (turns.length === 0) {
    if (await wasSandboxTurnAlreadyClosed(sessionId, identity)) {
      return {
        outcome: 'already_closed',
        activeTurnCount,
        closedTurnCount: 0,
      };
    }
    return {
      outcome: activeTurnCount > 0 ? 'identity_mismatch' : 'no_active_turn',
      activeTurnCount,
      closedTurnCount: 0,
    };
  }
  if (owner && turns.length > 0) {
    const endReason: SessionTurnEndReason = status === 'error' ? 'failed' : 'completed';
    await recordTurnLedger(
      endedTurnLedger(owner, turns, endReason),
      `complete ${turns.map((turn) => turn.token).join(',')} (${endReason})`,
    );
    // The backstop for an acceptance that never landed: `completed`/`failed`
    // both mean the turn RAN, so the prompt it carried is consumed either way.
    // The never-ran reasons (`abandoned`, `runtime_gone`, `unknown`) cannot
    // reach here — this path only ever writes the two — which is what keeps
    // this from racing `requeueAbandonedPrompt`, the owner of exactly those.
    for (const turn of turns) {
      await confirmInboxPromptConsumed(owner.sessionId, turn.messageId);
    }
  }
  return {
    outcome: 'closed',
    activeTurnCount,
    closedTurnCount: turns.length,
  };
}

/**
 * Close ONE open turn by the user message it was opened for — exact match only,
 * no fallback to an unkeyed record — and write its ledger end with `reason`.
 *
 * For prompts forwarded INTO a live turn: their records are opened per
 * message and the daemon's `end` relay names only the message the FINAL
 * assistant answered, so every other forwarded record of that turn would stay
 * open until a reaper sweep gave up on it (~20 s of "working" after the last
 * answer). `session-lifecycle/forwarded-strand-reconcile.ts` closes the ones
 * the step answered with `completed`, and the ones it stranded with
 * `abandoned` once they are re-queued; `inbox-hold-settle.ts` closes the ones
 * a Stop took back out of the transcript with `abandoned` too.
 *
 * Does NOT confirm inbox consumption: the callers decide what the row becomes.
 * Returns true when a record was closed.
 */
export async function closeSandboxTurnByMessageId(
  sessionId: string,
  messageId: string,
  reason: SessionTurnEndReason,
  graceMs = idleGraceMs(),
): Promise<boolean> {
  const metadata = jsonbObject(sql`s.metadata`);
  const result = await execute(sql`
    WITH target AS (
      SELECT s.sandbox_id,
             ${metadata} AS metadata
        FROM kortix.session_sandboxes s
       WHERE s.session_id = ${sessionId}
         AND s.status IN ('active', 'provisioning')
       FOR UPDATE OF s
    ), selected AS (
      SELECT target.sandbox_id,
             'activeTurns'::text AS source,
             entry.key,
             entry.value->>'token' AS token,
             entry.value
        FROM target
        CROSS JOIN LATERAL jsonb_each(CASE
          WHEN jsonb_typeof(target.metadata->'activeTurns') = 'object'
            THEN target.metadata->'activeTurns'
          ELSE '{}'::jsonb
        END) entry
       WHERE entry.value->>'state' IN ('delivering', 'active')
         AND entry.value->>'messageId' = ${messageId}
      UNION ALL
      SELECT target.sandbox_id,
             'activeTurn'::text AS source,
             'activeTurn'::text AS key,
             target.metadata->'activeTurn'->>'token' AS token,
             target.metadata->'activeTurn' AS value
        FROM target
       WHERE target.metadata->'activeTurn'->>'state' IN ('delivering', 'active')
         AND target.metadata->'activeTurn'->>'messageId' = ${messageId}
    ), next_state AS (
      SELECT target.sandbox_id,
             jsonb_set(
               CASE
                 WHEN EXISTS (
                   SELECT 1 FROM selected
                    WHERE selected.sandbox_id = target.sandbox_id
                      AND selected.source = 'activeTurn')
                 THEN target.metadata - 'activeTurn'
                 ELSE target.metadata
               END,
               '{activeTurns}',
               coalesce((
                 SELECT jsonb_object_agg(entry.key, entry.value)
                   FROM jsonb_each(CASE
                     WHEN jsonb_typeof(target.metadata->'activeTurns') = 'object'
                       THEN target.metadata->'activeTurns'
                     ELSE '{}'::jsonb
                   END) entry
                  WHERE NOT EXISTS (
                    SELECT 1 FROM selected
                     WHERE selected.sandbox_id = target.sandbox_id
                       AND selected.source = 'activeTurns'
                       AND selected.key = entry.key)),
                 '{}'::jsonb),
               true) AS metadata,
             (SELECT coalesce(
                       jsonb_agg(jsonb_build_object(
                         'token', selected.token,
                         'opencodeSessionId', selected.value->>'opencodeSessionId',
                         'messageId', selected.value->>'messageId',
                         'startedAtMs', selected.value->>'startedAtMs'))
                         FILTER (WHERE selected.token IS NOT NULL),
                       '[]'::jsonb)
                FROM selected
               WHERE selected.sandbox_id = target.sandbox_id) AS ended_turns
        FROM target
       WHERE EXISTS (SELECT 1 FROM selected WHERE selected.sandbox_id = target.sandbox_id)
    )
    UPDATE kortix.session_sandboxes s
       SET metadata = next_state.metadata,
           deadline_at = CASE
             WHEN next_state.metadata->'activeTurn'->>'state' IN ('delivering', 'active')
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_each(CASE
                     WHEN jsonb_typeof(next_state.metadata->'activeTurns') = 'object'
                       THEN next_state.metadata->'activeTurns'
                     ELSE '{}'::jsonb
                   END) remaining
                  WHERE remaining.value->>'state' IN ('delivering', 'active'))
             THEN s.deadline_at
             ELSE LEAST(
               s.deadline_at,
               now() + make_interval(secs => ${secs(graceMs)}))
           END,
           updated_at = now()
      FROM next_state
     WHERE s.sandbox_id = next_state.sandbox_id
    RETURNING next_state.ended_turns, s.session_id, s.sandbox_id, s.project_id, s.account_id`);
  const rows = normalizeRows(result);
  const owner = rows?.[0] ? ledgerIdentity(rows[0]) : null;
  const turns = endedLedgerTurns(rows?.[0]?.ended_turns);
  if (owner && turns.length > 0) {
    await recordTurnLedger(
      endedTurnLedger(owner, turns, reason),
      `close-by-message ${turns.map((turn) => turn.token).join(',')} (${reason})`,
    );
  }
  // The ledger row may still be open with its metadata entry already gone
  // (settled by a renewal/acceptance pass that never named this message):
  // close it directly, by the message it was opened for. Observation, never
  // authority — a failed write is logged and the reaper's backstop closes it.
  let closedLedger = false;
  try {
    const direct = await execute(sql`UPDATE kortix.session_turns
         SET state = 'ended', end_reason = ${reason}, ended_at = now(), updated_at = now()
       WHERE session_id = ${sessionId}
         AND message_id = ${messageId}
         AND state <> 'ended'
       RETURNING turn_token`);
    closedLedger = (normalizeRows(direct)?.length ?? 0) > 0;
  } catch (error) {
    console.warn(
      `[turn-ledger] close-by-message ledger write failed for ${messageId}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return turns.length > 0 || closedLedger;
}

/**
 * Renew one accepted turn after the reaper observes that exact OpenCode turn in
 * flight. The token CAS prevents stale evidence from renewing a newer turn.
 */
export async function renewActiveSandboxTurn(
  sandboxId: string,
  token: string,
  grantMs = turnGrantMs(),
): Promise<ActiveTurnRenewal> {
  const result = await execute(sql`
    UPDATE kortix.session_sandboxes s
       SET deadline_at = GREATEST(
             s.deadline_at,
             now() + make_interval(secs => ${secs(grantMs)})),
           updated_at = now()
     WHERE s.sandbox_id = ${sandboxId}::uuid
       AND s.status = 'active'
       AND (
         (s.metadata->'activeTurn'->>'token' = ${token}
           AND s.metadata->'activeTurn'->>'state' = 'active')
         OR (s.metadata->'activeTurns'->${token}->>'token' = ${token}
           AND s.metadata->'activeTurns'->${token}->>'state' = 'active'))
    RETURNING true AS renewed`);
  const rows = normalizeRows(result);
  if (!rows?.length) return 'inactive';
  return 'renewed';
}
