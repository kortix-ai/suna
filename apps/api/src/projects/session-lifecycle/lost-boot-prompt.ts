/**
 * Recovery for a BOOT PROMPT the runtime threw away.
 *
 * A session created with `initial_prompt` (every trigger fire, every subproject run)
 * does NOT go through the prompt inbox. The API pre-creates one `delivering`
 * turn record (`initialSandboxTurnMetadata`), the sandbox daemon claims the text
 * at boot (`turn-stream kind=initial_turn_claim`) and POSTs it straight to its
 * own OpenCode. If OpenCode does not persist that exact message, the daemon
 * reports `kind=turn_abandoned`, `abandonSandboxTurn` deletes the record, and
 * **nothing anywhere retries**. The prompt text stays in
 * `project_sessions.metadata.initial_prompt` and is never delivered again.
 *
 * Measured on a local stack, 2026-08-31: 7 of 10 sessions in one project ended
 * this way — `session_turns` holding a single `abandoned` row, no `accepted_at`,
 * an empty transcript, and the session reaped 15 minutes later. Every subproject run
 * that day produced no output. The mature path (`continue_session` through
 * `session_lifecycle_commands`) has agent-roster validation, env sync, a healing
 * retry loop, bounded attempts and a user-visible dead-letter. The boot path had
 * one shot and a silent drop. This pass hands a lost boot prompt to that path.
 *
 * WHY `accepted_at` IS THE DISCRIMINATOR
 * `acceptSandboxTurn` (`turn-stream kind=turn_accepted`) stamps `accepted_at`
 * only after OpenCode reports the boot message queued or running. So a session
 * with NO accepted turn never ran its prompt. `end_reason='abandoned'` alone is
 * NOT sufficient and using it would re-run paid work: a session can abandon the
 * pre-created record and still run (the daemon reuses a root, or OpenCode's
 * synthetic `<pty_exited>` wake-up gets adopted as `kind=turn_begin`). Both
 * shapes were present in the incident data.
 *
 * WHY IT IS BOUNDED IN TIME
 * A trigger run is only worth recovering while it is still the CURRENT run.
 * Past `LOST_BOOT_PROMPT_MAX_AGE_MS` the scheduled work is stale and the next
 * cron fire is the right recovery — re-running a day-old subproject would publish
 * last night's output as today's. The lower bound
 * (`LOST_BOOT_PROMPT_GRACE_MS`) lets the daemon's own boot retries and turn
 * adoption settle before this pass calls the prompt lost.
 *
 * The enqueue is at-most-once per session (`lostBootPromptIdempotencyKey`) and
 * lands in the inbox, which `GET /prompts` renders — so a recovery is visible to
 * the user as a pending prompt, never a silent second run.
 */

import { projectSessions, sessionTurns } from '@kortix/db';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { enqueueContinueSessionCommand } from './store';
import type { SessionInvocationSource } from './types';

/** Let the daemon's own boot retries and `turn_begin` adoption settle first. */
export const LOST_BOOT_PROMPT_GRACE_MS = 2 * 60 * 1000;
/** Past this the scheduled run is stale; the next trigger fire supersedes it. */
export const LOST_BOOT_PROMPT_MAX_AGE_MS = 60 * 60 * 1000;
/** Bounded batch — this is a backstop, not a queue. */
export const LOST_BOOT_PROMPT_BATCH = 20;

/** One recovery per session, ever. */
export function lostBootPromptIdempotencyKey(sessionId: string): string {
  return `lost-boot-prompt:${sessionId}`;
}

export interface LostBootPromptCandidate {
  sessionId: string;
  projectId: string;
  accountId: string;
  createdBy: string | null;
  agentName: string | null;
  initialPrompt: string;
  source: SessionInvocationSource;
}

export interface LostBootPromptResult {
  scanned: number;
  requeued: number;
  deduped: number;
  errors: number;
}

/**
 * The recovery prompt's overrides.
 *
 * The agent is carried so the run happens under the subproject's own agent rather
 * than the runtime default. `deliverPrompt` validates it against the live
 * roster (`resolveDeliverableAgent`) and drops an agent the runtime does not
 * have — which the boot path never did, and is one way a boot prompt reaches a
 * runtime that answers `204` and runs nothing.
 *
 * `directory` stays unset on purpose: `deliverPrompt` falls back to `/workspace`,
 * the same directory the boot delivery used.
 */
export function lostBootPromptOverrides(agentName: string | null) {
  const agent = agentName?.trim();
  return agent && agent !== 'default' ? { agent } : undefined;
}

/**
 * Sessions whose boot prompt was abandoned and never ran.
 *
 * Every condition is a durable database fact, so this needs no sandbox and
 * works long after the box was reaped:
 *   - the session still carries the prompt text;
 *   - it has an `abandoned` turn inside the recovery window;
 *   - it has NO turn OpenCode ever accepted;
 *   - the user did not delete the session.
 */
export async function loadLostBootPromptCandidates(
  now: Date,
  limit = LOST_BOOT_PROMPT_BATCH,
): Promise<LostBootPromptCandidate[]> {
  const abandonedFloor = new Date(now.getTime() - LOST_BOOT_PROMPT_MAX_AGE_MS);
  const abandonedCeiling = new Date(now.getTime() - LOST_BOOT_PROMPT_GRACE_MS);

  const rows = await db
    .selectDistinct({
      sessionId: projectSessions.sessionId,
      projectId: projectSessions.projectId,
      accountId: projectSessions.accountId,
      createdBy: projectSessions.createdBy,
      agentName: projectSessions.agentName,
      initialPrompt: sql<string>`${projectSessions.metadata}->>'initial_prompt'`,
      source: sql<string>`${projectSessions.metadata}->>'source'`,
    })
    .from(projectSessions)
    .innerJoin(sessionTurns, eq(sessionTurns.sessionId, projectSessions.sessionId))
    .where(
      and(
        sql`${projectSessions.metadata}->>'initial_prompt' IS NOT NULL`,
        sql`length(trim(${projectSessions.metadata}->>'initial_prompt')) > 0`,
        // deleteSession() stamps this and leaves the row 'stopped'; a deleted
        // session must never be revived by a backstop.
        sql`${projectSessions.metadata}->>'deletedAt' IS NULL`,
        eq(sessionTurns.endReason, 'abandoned'),
        isNull(sessionTurns.acceptedAt),
        gt(sessionTurns.startedAt, abandonedFloor),
        lt(sessionTurns.startedAt, abandonedCeiling),
        // NOT EXISTS a turn OpenCode ever accepted — the proof the prompt ran.
        sql`NOT EXISTS (
          SELECT 1 FROM ${sessionTurns} accepted
           WHERE accepted.session_id = ${projectSessions.sessionId}
             AND accepted.accepted_at IS NOT NULL
        )`,
      ),
    )
    .limit(limit);

  return rows
    .filter((row) => typeof row.initialPrompt === 'string' && row.initialPrompt.trim().length > 0)
    .map((row) => ({
      sessionId: row.sessionId,
      projectId: row.projectId,
      accountId: row.accountId,
      createdBy: row.createdBy,
      agentName: row.agentName,
      initialPrompt: row.initialPrompt,
      // The session's own recorded source, so the recovered prompt is
      // attributed to the trigger that produced it rather than to a human.
      source: normalizeSource(row.source),
    }));
}

const KNOWN_SOURCES = new Set<SessionInvocationSource>([
  'ui',
  'mobile',
  'cli',
  'slack',
  'email',
  'telegram',
  'teams',
  'trigger:webhook',
  'trigger:cron',
  'trigger:manual',
  'trigger:monitor',
  'system:sandbox-build-fix',
  'system:approval-resume',
  'system:secret-submitted',
  'system:connector-connected',
  'admin',
]);

/** `metadata.source` is free-form text in the row; only a known value is kept. */
export function normalizeSource(raw: unknown): SessionInvocationSource {
  return typeof raw === 'string' && KNOWN_SOURCES.has(raw as SessionInvocationSource)
    ? (raw as SessionInvocationSource)
    : 'trigger:cron';
}

export async function reconcileLostBootPrompts(now = new Date()): Promise<LostBootPromptResult> {
  const out: LostBootPromptResult = { scanned: 0, requeued: 0, deduped: 0, errors: 0 };
  let candidates: LostBootPromptCandidate[];
  try {
    candidates = await loadLostBootPromptCandidates(now);
  } catch (err) {
    logger.error('[lost-boot-prompt] candidate scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...out, errors: 1 };
  }
  out.scanned = candidates.length;
  if (candidates.length === 0) return out;

  for (const candidate of candidates) {
    try {
      const enqueued = await enqueueContinueSessionCommand({
        source: candidate.source,
        projectId: candidate.projectId,
        accountId: candidate.accountId,
        sessionId: candidate.sessionId,
        actorUserId: candidate.createdBy,
        text: candidate.initialPrompt,
        idempotencyKey: lostBootPromptIdempotencyKey(candidate.sessionId),
        overrides: lostBootPromptOverrides(candidate.agentName),
      });
      if (enqueued.deduped) {
        out.deduped += 1;
        continue;
      }
      out.requeued += 1;
      // Loud on purpose: a boot prompt reaching this pass means the runtime
      // dropped it, which is a runtime bug this backstop only papers over.
      logger.error('[lost-boot-prompt] boot prompt was never delivered — requeued to the inbox', {
        session_id: candidate.sessionId,
        project_id: candidate.projectId,
        source: candidate.source,
        agent: candidate.agentName,
        command_id: enqueued.row.commandId,
      });
    } catch (err) {
      out.errors += 1;
      logger.error('[lost-boot-prompt] requeue failed', {
        session_id: candidate.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
