/**
 * The session-open hold for a box below the runtime floor (`runtime-floor-policy.ts`):
 * read the box's own health, then serve it, hold it while it installs the
 * current daemon, stop its old daemon, or refuse it with the reason.
 *
 * Runs on every open of a provider-running box whose daemon answered. On a box
 * at the floor it costs nothing: the readiness phase already read its
 * capabilities. It writes the box's `runtimeFloor` stamp once per box, and the
 * delivery fast path (`awakeDeliveryTarget`) serves only stamped boxes, so a
 * message cannot reach an old daemon while its open is held.
 */
import type { SessionStartResult } from '@kortix/api-contract';
import { sessionSandboxes } from '@kortix/db';
import { isRecord } from '@kortix/shared/guards';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { getProvider, type ProviderName } from '../../platform/providers';
import { db } from '../../shared/db';
import { sandboxRuntimeEndpoint } from '../runtime-session-mapping';
import { sessionHoldsTurnAuthority } from '../session-lifecycle/inbox-admission';
import { sessionRuntimeFetch } from '../session-lifecycle/runtime-fetch';
import {
  currentBelowSpell,
  decideRuntimeFloor,
  decideRuntimeFloorWhileBooting,
  healthServesRuntimeFloor,
  readRuntimeFloorRecord,
  RUNTIME_FLOOR_CAPABILITY,
  RUNTIME_FLOOR_METADATA_KEY,
  RUNTIME_FLOOR_RESTART_METADATA_KEY,
  runtimeFloorRestartCommand,
  runtimeFloorRestartCutoff,
  type RuntimeFloorBelow,
  type RuntimeFloorRecord,
  type RuntimeFloorRefusal,
} from './runtime-floor-policy';
import type { OpenSessionArgs, OpenSessionRow } from './session-open-context';
import { serializeSandboxRow, sessionRuntimeUrlPath } from './stopped-wake-result';

const HEALTH_TIMEOUT_MS = 8_000;
const RESTART_EXEC_TIMEOUT_MS = 20_000;

/**
 * Answers `null` when the open continues: the box serves the floor, its health
 * could not be read (the readiness probe answered moments earlier, and a flaky
 * second probe must not hold a session), or it boots outside a spell below the
 * floor. Otherwise the answer to return.
 */
export async function holdBelowRuntimeFloor(
  args: OpenSessionArgs,
  row: OpenSessionRow,
  externalId: string,
  capabilities: string[] | null,
  booting: boolean,
): Promise<SessionStartResult | null> {
  const record = readRuntimeFloorRecord(row.metadata as Record<string, unknown> | null);
  if (booting) {
    const whileBooting = decideRuntimeFloorWhileBooting(record, externalId, Date.now());
    if (whileBooting.action === 'none') return null;
    if (whileBooting.action === 'refuse') return refuse(args, row, externalId, whileBooting.why, currentBelowSpell(record, externalId, Date.now()));
    await writeRecord(row.sandboxId, { below: storedSpell(whileBooting.spell) });
    return holdingAnswer(args, row, externalId);
  }
  if (capabilities?.includes(RUNTIME_FLOOR_CAPABILITY)) {
    await stampServing(row, record, externalId);
    return null;
  }

  const health = await readHealth(externalId, args.loaded.userId);
  if (!health) {
    logger.warn('[runtime-floor] no health to judge the box by; serving it unstamped', {
      sandbox_id: row.sandboxId,
      external_id: externalId,
    });
    return null;
  }
  if (healthServesRuntimeFloor(health)) {
    await stampServing(row, record, externalId);
    return null;
  }

  const nowMs = Date.now();
  const spell = currentBelowSpell(record, externalId, nowMs);
  const decision = decideRuntimeFloor({
    health,
    spell,
    turnHeld: sessionHoldsTurnAuthority({ status: row.status, metadata: row.metadata }),
    canExec: providerCanExec(row.provider),
    nowMs,
  });
  // One line per spell while it waits, one per action: an open polls every second.
  if (decision.action !== 'wait' || spell.since === spell.seenAt) logger.info('[runtime-floor] box below the runtime floor', {
    session_id: row.sessionId,
    sandbox_id: row.sandboxId,
    external_id: externalId,
    decision: decision.action,
    why: 'why' in decision ? decision.why : null,
    below_since: spell.since,
  });

  switch (decision.action) {
    case 'serve':
      await stampServing(row, record, externalId);
      return null;
    case 'wait':
      await writeRecord(row.sandboxId, { below: storedSpell(spell) });
      return holdingAnswer(args, row, externalId);
    case 'restart':
      await writeRecord(row.sandboxId, { below: storedSpell(spell) });
      if (await claimRestart(row.sandboxId, externalId, nowMs)) {
        await stopOldDaemon(row, externalId);
      }
      return holdingAnswer(args, row, externalId);
    case 'refuse':
      return refuse(args, row, externalId, decision.why, spell);
  }
}

const REFUSAL_EVIDENCE: Record<RuntimeFloorRefusal, string> = {
  pinned: 'the box rolled a runtime update back and turned updates off',
  no_exec: 'the box provider cannot run the update command',
  not_staged: 'the box did not download the current runtime',
  restart_did_not_land: 'the box did not start the current runtime after a restart',
};

/**
 * The box cannot reach the floor. Refuse the open with the reason. The box is
 * left running as it is: its identity is immutable and it may hold uncommitted
 * work.
 */
async function refuse(
  args: OpenSessionArgs,
  row: OpenSessionRow,
  externalId: string,
  why: RuntimeFloorRefusal,
  spell: RuntimeFloorBelow,
): Promise<SessionStartResult> {
  // The spell replaces the record, so the box loses any `current` stamp: the
  // delivery fast path must not reach a daemon this open refused.
  await writeRecord(row.sandboxId, { below: storedSpell(spell) });
  logger.warn('[runtime-floor] refusing a box that cannot reach the runtime floor', {
    session_id: row.sessionId,
    sandbox_id: row.sandboxId,
    external_id: externalId,
    why,
  });
  return {
    stage: 'failed',
    agent_name: args.visible.row.agentName ?? 'default',
    retriable: false,
    sandbox: serializeSandboxRow(row),
    runtime_session_id: null,
    runtime_url: sessionRuntimeUrlPath(externalId),
    reason: 'runtime_below_floor',
    failure: {
      category: 'sandbox-provider',
      message:
        "This session's computer runs an old version of the Kortix runtime and cannot update to the current one. The conversation stays readable. Start a new session to continue the work.",
      retryable: false,
      evidence: {
        check: `runtime_below_floor:${why}: ${REFUSAL_EVIDENCE[why]}`,
        observed_at: new Date().toISOString(),
        error: null,
        attempts: 0,
        next_retry_at: null,
      },
    },
  };
}

function holdingAnswer(args: OpenSessionArgs, row: OpenSessionRow, externalId: string): SessionStartResult {
  return {
    stage: 'starting',
    agent_name: args.visible.row.agentName ?? 'default',
    retriable: true,
    sandbox: serializeSandboxRow(row),
    runtime_session_id: null,
    runtime_url: sessionRuntimeUrlPath(externalId),
    reason: 'runtime_updating',
  };
}

/** `/kortix/health?turn=1`, read fresh: the box's daemon changes during the hold. */
async function readHealth(externalId: string, userId: string): Promise<Record<string, unknown> | null> {
  try {
    const endpoint = await sandboxRuntimeEndpoint(externalId, userId);
    if (!endpoint) return null;
    const res = await sessionRuntimeFetch(endpoint, 'GET', '/kortix/health?turn=1', {}, HEALTH_TIMEOUT_MS);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const body: unknown = await res.json().catch(() => null);
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function providerCanExec(provider: string): boolean {
  try {
    return typeof getProvider(provider as ProviderName).exec === 'function';
  } catch {
    return false;
  }
}

async function stampServing(row: OpenSessionRow, record: RuntimeFloorRecord, externalId: string): Promise<void> {
  if (record.current?.externalId === externalId && !record.below) return;
  await writeRecord(row.sandboxId, { current: { externalId, at: new Date().toISOString() } }).catch((err) =>
    logger.warn('[runtime-floor] could not stamp the box as current', {
      sandbox_id: row.sandboxId,
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}

/** Replaces the whole record: a box below the floor loses its `current` stamp. */
async function writeRecord(sandboxId: string, record: RuntimeFloorRecord): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({ metadata: mergedMetadata(record) })
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
}

function mergedMetadata(record: RuntimeFloorRecord) {
  return sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ [RUNTIME_FLOOR_METADATA_KEY]: record })}::jsonb`;
}

/** The spell as stored: its stop lives under its own key. */
function storedSpell(spell: RuntimeFloorBelow): RuntimeFloorBelow {
  return { externalId: spell.externalId, since: spell.since, seenAt: spell.seenAt };
}

/**
 * One stop per box per `RUNTIME_FLOOR_SPELL_GAP_MS`, across every replica and
 * every poll: the row is updated only when it records no stop of this box since
 * the cutoff. Two fast exits in a row make the box's supervisor roll back and
 * pin updates off.
 */
async function claimRestart(sandboxId: string, externalId: string, nowMs: number): Promise<boolean> {
  const last = sql`${sessionSandboxes.metadata}->${RUNTIME_FLOOR_RESTART_METADATA_KEY}`;
  const stop = { [RUNTIME_FLOOR_RESTART_METADATA_KEY]: { externalId, at: new Date(nowMs).toISOString() } };
  const [won] = await db
    .update(sessionSandboxes)
    .set({ metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(stop)}::jsonb` })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        sql`NOT (
          coalesce(${last}->>'externalId', '') = ${externalId}
          AND coalesce(${last}->>'at', '') > ${runtimeFloorRestartCutoff(nowMs)}
        )`,
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId });
  return Boolean(won);
}

async function stopOldDaemon(row: OpenSessionRow, externalId: string): Promise<void> {
  try {
    const provider = getProvider(row.provider as ProviderName);
    if (!provider.exec) throw new Error(`provider ${row.provider} has no exec channel`);
    const result = await provider.exec(externalId, runtimeFloorRestartCommand(), { timeoutMs: RESTART_EXEC_TIMEOUT_MS });
    logger.info('[runtime-floor] stopped the old daemon; the supervisor starts the staged one', {
      session_id: row.sessionId,
      sandbox_id: row.sandboxId,
      external_id: externalId,
      exit_code: result.exitCode,
      stdout: result.stdout.trim().slice(0, 200),
    });
  } catch (err) {
    // The spell keeps its stop: the restart budget then refuses the box
    // instead of stopping it again.
    logger.warn('[runtime-floor] could not stop the old daemon', {
      session_id: row.sessionId,
      sandbox_id: row.sandboxId,
      external_id: externalId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
