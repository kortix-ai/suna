import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { piWorkerRuntimeIdentityFromSessionMetadata } from './lib/session-sandbox-metadata';
import { sandboxStopClaimLeaseMs, turnGrantMs } from './sandbox-deadline-policy';
import { storedSandboxTurns } from './sandbox-turn-lifecycle';

export interface PiTurnRecoveryIdentity {
  opencodeSessionId: string;
  messageId: string;
  ownerId: string;
}

export async function resumePiSandboxTurn(
  sandboxId: string,
  identity: PiTurnRecoveryIdentity,
): Promise<'resumed' | 'already_active' | 'unavailable' | 'invalid_owner' | 'terminal' | 'busy'> {
  const token = 'pi-resume-' + createHash('sha256')
    .update(JSON.stringify([sandboxId, identity.messageId, identity.ownerId])).digest('hex');
  return db.transaction(async (tx) => {
    const [box] = await tx.execute(sql`
      SELECT s.sandbox_id, s.session_id, s.project_id, s.account_id, s.metadata,
             p.metadata AS session_metadata
        FROM kortix.session_sandboxes s
        JOIN kortix.project_sessions p
          ON p.session_id = s.session_id AND p.project_id = s.project_id AND p.account_id = s.account_id
       WHERE s.sandbox_id = ${sandboxId}::uuid AND s.status IN ('active', 'provisioning')
         AND p.metadata->>'deletedAt' IS NULL
         AND (s.metadata->'lifecycleStopClaim' IS NULL
           OR s.metadata->'lifecycleStopClaim'->>'claimedAtMs' !~ '^[0-9]+$'
           OR (s.metadata->'lifecycleStopClaim'->>'claimedAtMs')::bigint
             <= floor(extract(epoch from now()) * 1000) - ${sandboxStopClaimLeaseMs()})
       FOR UPDATE OF s`);
    if (!box || !piWorkerRuntimeIdentityFromSessionMetadata(box.session_metadata)) return 'unavailable';

    const [proof] = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM kortix.session_worker_log
         WHERE session_id = ${box.session_id} AND item->>'kind' = 'journal'
           AND item->>'stream' = 'kortix.pi.turn-admission.v1'
           AND item->'record'->>'type' = 'accepted'
           AND item->'record'->'turn'->>'messageId' = ${identity.messageId}
           AND item->'record'->'turn'->'wireUserMessage'->'info'->>'sessionID' = ${identity.opencodeSessionId}
      ) AS accepted, EXISTS (
        SELECT 1 FROM kortix.session_worker_log
         WHERE session_id = ${box.session_id} AND item->>'kind' = 'journal'
           AND item->>'stream' = 'kortix.pi.turn-admission.v1'
           AND item->'record'->>'messageId' = ${identity.messageId}
           AND item->'record'->>'type' IN ('completed', 'cancelled', 'abort_requested', 'abort_acknowledged')
      ) AS terminal, (
        SELECT item->'record'->>'ownerId' FROM kortix.session_worker_log
         WHERE session_id = ${box.session_id} AND item->>'kind' = 'journal'
           AND item->>'stream' = 'kortix.pi.turn-admission.v1'
           AND item->'record'->>'messageId' = ${identity.messageId}
           AND item->'record'->>'type' IN ('started', 'reclaimed')
         ORDER BY id DESC LIMIT 1
      ) AS owner_id`);
    if (proof?.terminal) return 'terminal';
    if (!proof?.accepted || proof.owner_id !== identity.ownerId) return 'invalid_owner';

    const turns = await tx.execute(sql`
      SELECT turn_token, message_id, opencode_session_id, state, end_reason
        FROM kortix.session_turns WHERE sandbox_id = ${sandboxId}::uuid
          AND (state <> 'ended' OR message_id = ${identity.messageId})
        ORDER BY created_at DESC, turn_token DESC`);
    const existing = turns.find((turn) => turn.turn_token === token);
    if (existing?.state === 'ended') return 'terminal';
    const active = turns.filter((turn) => turn.state !== 'ended');
    const metadata = (box.metadata ?? {}) as Record<string, unknown>;
    const authority = storedSandboxTurns(metadata);
    if ([...active, ...authority.map((turn) => ({ message_id: turn.messageId, opencode_session_id: turn.opencodeSessionId }))]
      .some((turn) => turn.message_id !== identity.messageId || turn.opencode_session_id !== identity.opencodeSessionId)) return 'busy';
    if (existing) return authority.some((turn) => turn.token === token) ? 'already_active' : 'unavailable';
    if (!active.length && turns[0]?.end_reason !== 'runtime_gone') return 'terminal';

    await tx.execute(sql`
      UPDATE kortix.session_turns SET state = 'ended', end_reason = 'runtime_gone', ended_at = now(), updated_at = now()
       WHERE sandbox_id = ${sandboxId}::uuid AND state <> 'ended'`);
    await tx.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id, opencode_session_id, message_id, state, accepted_at)
      VALUES (${token}, ${box.session_id}, ${sandboxId}::uuid, ${box.project_id}::uuid, ${box.account_id}::uuid,
        ${identity.opencodeSessionId}, ${identity.messageId}, 'active', now())`);
    await tx.execute(sql`
      UPDATE kortix.session_sandboxes
         SET metadata = (coalesce(metadata, '{}'::jsonb) - 'activeTurn' - 'activeTurns' - 'lifecycleStopClaim')
           || jsonb_build_object('activeTurns', jsonb_build_object(${token}::text, jsonb_build_object(
             'token', ${token}::text, 'messageId', ${identity.messageId}::text,
             'opencodeSessionId', ${identity.opencodeSessionId}::text, 'runtimeOwnerId', ${identity.ownerId}::text,
             'state', 'active', 'startedAtMs', floor(extract(epoch from now()) * 1000)))),
           deadline_at = greatest(deadline_at, now() + make_interval(secs => ${Math.round(turnGrantMs() / 1000)})),
           updated_at = now()
       WHERE sandbox_id = ${sandboxId}::uuid`);
    return 'resumed';
  });
}
