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
 * Mint the identity that crosses the API -> provider -> daemon boundary for a
 * prompt delivered directly by the daemon during boot. The sandbox receives
 * the opaque token, but it cannot create or revive the matching database row.
 */
export function prepareInitialSandboxTurn(nowMs = Date.now()): PreparedInitialSandboxTurn {
  return {
    token: randomUUID(),
    messageId: `msg_${nowMs.toString(36)}${randomUUID().replaceAll('-', '')}`,
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
  };
}

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
      RETURNING true AS granted`);
  const rows = normalizeRows(result);
  if (rows === null) {
    throw new Error('sandbox turn lifecycle write returned an unsupported database result');
  }
  if (rows.length === 0) return 'no_box';
  return 'granted';
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
    RETURNING true AS accepted`);
  return (normalizeRows(result)?.length ?? 0) > 0;
}

/** Remove a delivery record only when this request still owns it. */
export async function abandonSandboxTurn(target: DeadlineTarget, token: string): Promise<boolean> {
  const result = await execute(sql`
    UPDATE kortix.session_sandboxes s
       SET metadata = CASE
             WHEN s.metadata->'activeTurns'->${token} IS NOT NULL THEN
               jsonb_set(
                 coalesce(s.metadata, '{}'::jsonb),
                 '{activeTurns}',
                 coalesce(s.metadata->'activeTurns', '{}'::jsonb) - ${token},
                 true)
             ELSE coalesce(s.metadata, '{}'::jsonb) - 'activeTurn'
           END,
           updated_at = now()
     WHERE ${targetPredicate(target)}
       AND (
         (s.metadata->'activeTurns'->${token}->>'token' = ${token}
           AND s.metadata->'activeTurns'->${token}->>'state' = 'delivering')
         OR (s.metadata->'activeTurn'->>'token' = ${token}
           AND s.metadata->'activeTurn'->>'state' = 'delivering'))
    RETURNING true AS abandoned`);
  const rows = normalizeRows(result);
  return rows === null || rows.length > 0;
}

/** Repair the delivery-to-acceptance gap from provider-neutral OpenCode evidence. */
export async function reconcileSandboxTurnDelivery(
  sandboxId: string,
  token: string,
  observation: SandboxTurnObservation,
): Promise<SandboxTurnDeliveryReconciliation> {
  if (observation === 'active') {
    return (await acceptSandboxTurn({ sandboxId }, token)) ? 'active' : 'inactive';
  }
  if (observation === 'terminal') {
    await clearSandboxTurn(sandboxId, token);
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
): Promise<boolean> {
  const metadata = jsonbObject(sql`s.metadata`);
  const result = await execute(sql`
    WITH target AS (
      SELECT s.sandbox_id,
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
    RETURNING true AS cleared`);
  return (normalizeRows(result)?.length ?? 0) > 0;
}

/**
 * Apply terminal evidence. A retryable error is not terminal. When both sides
 * know the OpenCode user message ID, a delayed event may clear only that turn.
 * Older daemons and command turns have no message ID; they remain scoped to the
 * root OpenCode session for rolling-deploy compatibility.
 */
export async function completeSandboxTurn(
  sessionId: string,
  status: 'idle' | 'error',
  identity?: Partial<SandboxTurnIdentity> | null,
  error?: { isRetryable?: boolean } | null,
  graceMs = idleGraceMs(),
): Promise<boolean> {
  if (!isTerminalTurnEnd(status, error)) return false;
  const metadata = jsonbObject(sql`s.metadata`);
  const result = await execute(sql`
    WITH target AS (
      SELECT s.sandbox_id,
             ${metadata} AS metadata
        FROM kortix.session_sandboxes s
       WHERE s.session_id = ${sessionId}
         AND s.status IN ('active', 'provisioning')
       FOR UPDATE OF s
    ), turn_candidates AS (
      SELECT target.sandbox_id,
             'activeTurns'::text AS source,
             entry.key,
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
             target.metadata->'activeTurn' AS value
        FROM target
       WHERE target.metadata->'activeTurn'->>'state' IN ('delivering', 'active')
         AND (target.metadata->'activeTurn'->>'opencodeSessionId' IS NULL
           OR (${identity?.opencodeSessionId ?? null}::text IS NOT NULL
             AND target.metadata->'activeTurn'->>'opencodeSessionId' = ${identity?.opencodeSessionId ?? null}))
    ), exact_matches AS (
      SELECT candidate.sandbox_id, candidate.source, candidate.key
        FROM turn_candidates candidate
       WHERE ${identity?.messageId ?? null}::text IS NOT NULL
         AND candidate.value->>'messageId' = ${identity?.messageId ?? null}
    ), fallback_match AS (
      SELECT candidate.sandbox_id, candidate.source, candidate.key
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
               true) AS metadata
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
    RETURNING true AS completed`);
  return (normalizeRows(result)?.length ?? 0) > 0;
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
