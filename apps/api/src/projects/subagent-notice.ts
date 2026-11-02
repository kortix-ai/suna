/**
 * Background subagents: the parent session hears when its child finishes.
 *
 * The pi `agent` tool's `run_in_background` (kortixd
 * `harness/pi/cloud-subagent.ts`) starts a real child session with
 * `metadata.notify_parent: true` and returns at once. When the child's work
 * is done, this module delivers ONE message into the parent: the child's id,
 * status and final report. Claude Code delivers a finished background
 * subagent the same way, as a notification in a later turn.
 *
 * The message is a durable `continue_session` row, the same shape as
 * `connectors/notify-session.ts`: a synthetic (harness) part, a `steer` into
 * a running parent turn, else a new turn. The lifecycle engine wakes a
 * stopped parent to deliver it, so a parent box that restarted or parked
 * meanwhile still gets it.
 *
 * Rules:
 *  - Only a child its parent's own token started: `parent_session_id` must
 *    equal the server-managed `spawned_by_session`.
 *  - One message per finished turn: the idempotency key names the child and
 *    the turn, so a second end of the same turn inserts nothing.
 *  - "Finished" means settled: a child with a queued prompt, or a background
 *    child of its own still working, is not done. Its parent hears once,
 *    after the last of them settles, never once per grandchild.
 *  - A child that never started (provisioning failed) reports `failed` once.
 *  - A child someone other than its parent stops mid-turn reports `stopped`.
 *
 * Teammates (agent teams): a child whose `team_lead` is its parent always
 * notifies its lead, `notify_parent` or not, and the notice names the team
 * tasks it still owns, as Claude Code tells a lead when a teammate goes idle.
 *
 * Notices are coalesced (`session-notice-batch.ts`): several that arrive
 * together reach the parent as ONE delivery, so five finished agents wake a
 * stopped parent once and start one turn, not five.
 *
 * Never throws: it runs beside the turn-end relay and provisioning cleanup.
 * ponytail: the report is read between the turn end and the enqueue (~1 s);
 * an API process killed in that window drops that one message. The parent can
 * still read the child (`kortix sessions log <task_id>`).
 */
import { TEAM_LEAD_KEY } from '@kortix/api-contract/multi-agent';
import { SUBAGENT_NOTIFY_PARENT_KEY } from '@kortix/api-contract/runtime-relay';
import { projectSessions } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { registerSessionFailureNotifier } from '../shared/session-failure-notifier';
import { registerTurnLostNotifier } from '../shared/turn-lost-notifier';
import type { ProjectSessionRow } from './lib/serializers';
import { buildSessionTranscriptDigest } from './lib/session-transcript';
import { readSessionsWorking } from './lib/session-working-read';
import { enqueueSessionNotice } from './session-notice-batch';
import { ABORT_END_ERROR_NAMES } from './session-turn-ledger';
import { tasksOwnedBy, teamHandle } from './team-tasks/service';

export type SubagentNoticeStatus = 'completed' | 'error' | 'stopped' | 'failed';

/** Messages read back from the child to find its last report. */
const READ_BACK_MESSAGES = 20;

/** True when the session is a teammate of its parent (agent teams: `team_lead` = the parent). */
export function isTeammateRow(row: Pick<ProjectSessionRow, 'parentSessionId' | 'metadata'>): boolean {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return !!row.parentSessionId && meta[TEAM_LEAD_KEY] === row.parentSessionId;
}

/** The parent this child reports to, or null when it is neither a background subagent nor a teammate. */
export function noticeParentOf(row: Pick<ProjectSessionRow, 'parentSessionId' | 'metadata'>): string | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if ((meta[SUBAGENT_NOTIFY_PARENT_KEY] !== true && !isTeammateRow(row)) || typeof meta.deletedAt === 'string') return null;
  const parent = row.parentSessionId;
  return parent && meta.spawned_by_session === parent ? parent : null;
}

/**
 * The message the parent receives. The `session-report` element is the one
 * the web transcript already draws as a "Worker complete / failed" card that
 * opens the child session (`@kortix/ui` `SessionReportCard`); the lines around
 * it are for the model. Exported for tests.
 */
export function subagentNoticeText(input: {
  childId: string;
  status: SubagentNoticeStatus;
  agent: string | null;
  title: string | null;
  report: string;
  error?: string | null;
  /** A teammate: its handle and the team tasks it still owns. */
  teammate?: { handle: string; tasks: Array<{ seq: number; subject: string; status: string }> } | null;
}): string {
  const body =
    input.status === 'completed'
      ? `<task_result>\n${input.report || 'The subagent finished without a text report.'}\n</task_result>`
      : `<task_error>\n${input.error || `The subagent ${input.status === 'stopped' ? 'was stopped' : 'failed'}.`}\n</task_error>${input.report ? `\n<task_result>\n${input.report}\n</task_result>` : ''}`;
  const teammate = input.teammate;
  const taskLines = teammate
    ? teammate.tasks.length > 0
      ? [`Tasks ${teammate.handle} still owns: ${teammate.tasks.map((t) => `#${t.seq} ${t.subject} (${t.status.replace('_', ' ')})`).join('; ')}.`]
      : [`${teammate.handle} owns no unfinished task.`]
    : [];
  return [
    teammate
      ? `Your teammate ${teammate.handle} finished its turn and is idle. This message is from the platform, not from the user.`
      : 'A background subagent you started has finished. This message is from the platform, not from the user.',
    `task_id: ${input.childId}`,
    `status: ${input.status}`,
    '',
    '<kortix_system type="session-report" source="subagent">',
    '<session-report>',
    `<session-id>${input.childId}</session-id>`,
    `<status>${input.status === 'completed' ? 'COMPLETE' : 'FAILED'}</status>`,
    `<project>${input.agent ?? ''}</project>`,
    `<prompt>${input.title ?? ''}</prompt>`,
    `<result>\n${body}\n</result>`,
    '</session-report>',
    '</kortix_system>',
    ...(taskLines.length > 0 ? ['', ...taskLines] : []),
    '',
    `Continue your task with this result. To send this subagent a follow-up, call \`agent\` with task_id ${input.childId}. To read its whole transcript: \`kortix sessions log ${input.childId}\`.`,
  ].join('\n');
}

/**
 * A turn of `sessionId` ended (`settleTurnEnd`). Deliver the notice to its
 * parent when it is a settled background subagent. True when a row was written.
 */
export async function notifyParentOfSubagentTurn(input: {
  sessionId: string;
  status: 'idle' | 'error';
  errorInfo?: { name?: string; message?: string; code?: string } | null;
  turnMessageId: string | null;
}): Promise<boolean> {
  try {
    const child = await loadSession(input.sessionId);
    const parentId = child && noticeParentOf(child);
    if (!child || !parentId) return false;
    if (await stillWorking(child.sessionId)) return false;
    const aborted = !!input.errorInfo && (ABORT_END_ERROR_NAMES.includes(input.errorInfo.name ?? '') || input.errorInfo.code === 'aborted');
    const status: SubagentNoticeStatus = input.status === 'idle' ? 'completed' : aborted ? 'stopped' : 'error';
    const read = await readReport(child);
    const turnError = input.status === 'error' ? [input.errorInfo?.name, input.errorInfo?.message].filter(Boolean).join(': ') : '';
    return await deliver(child, parentId, input.turnMessageId ?? `ended:${Date.now()}`, {
      status: read.error && status === 'completed' ? 'error' : status,
      report: read.text,
      error: turnError || read.error || null,
    });
  } catch (err) {
    logger.warn('[subagent-notice] turn-end notice failed', { sessionId: input.sessionId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** The child's first box never came up: tell the parent once. */
export async function notifyParentOfFailedStart(sessionId: string, message: string): Promise<boolean> {
  try {
    const child = await loadSession(sessionId);
    const parentId = child && noticeParentOf(child);
    if (!child || !parentId) return false;
    return await deliver(child, parentId, 'start-failed', { status: 'failed', report: '', error: message });
  } catch (err) {
    logger.warn('[subagent-notice] failed-start notice failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

registerSessionFailureNotifier(notifyParentOfFailedStart);

/**
 * The reaper settled a turn of `sessionId` without its box (`runtime_gone`):
 * the turn-end relay never ran. Tell a waiting parent once; the notice key
 * names the lost turn.
 */
export function notifyParentOfLostTurn(sessionId: string, turnToken: string): Promise<boolean> {
  return notifyParentOfSubagentTurn({
    sessionId,
    status: 'error',
    errorInfo: { name: 'runtime_gone', message: 'Its computer stopped before it finished. Start it again, or hand the work to another agent.' },
    turnMessageId: `lost:${turnToken}`,
  });
}

registerTurnLostNotifier(notifyParentOfLostTurn);

/**
 * Before a stop (`POST …/sessions/:id/stop`): when `sessionId` is a background
 * subagent with live work and the stopper is not its parent, the notice to
 * send once the stop lands. A stop ends the turn without a turn end the
 * parent would hear. The parent's own stop needs no notice: its command
 * output already says so. Keyed on the stopped turn, so a second Stop of the
 * same turn sends nothing.
 */
export async function stoppedSubagentNotice(
  sessionId: string,
  stoppedBySession: string | null,
): Promise<(() => Promise<boolean>) | null> {
  try {
    const child = await loadSession(sessionId);
    const parentId = child && noticeParentOf(child);
    if (!child || !parentId || parentId === stoppedBySession) return null;
    const working = (await readSessionsWorking([sessionId])).get(sessionId);
    if (working?.state !== 'working') return null;
    const turnKey = `stopped:${working.turn_token ?? working.since ?? 'pending'}`;
    const by = stoppedBySession ? 'Another session' : 'A person';
    return () =>
      deliver(child, parentId, turnKey, { status: 'stopped', report: '', error: `${by} stopped it before it finished.` }).catch((err) => {
        logger.warn('[subagent-notice] stop notice failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
        return false;
      });
  } catch (err) {
    logger.warn('[subagent-notice] stop notice check failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function loadSession(sessionId: string): Promise<ProjectSessionRow | null> {
  const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  return row ?? null;
}

/** A queued prompt of the child, or a background child of its own still working. */
async function stillWorking(childId: string): Promise<boolean> {
  const kids = await db
    .select({ sessionId: projectSessions.sessionId, status: projectSessions.status })
    .from(projectSessions)
    .where(and(
      eq(projectSessions.parentSessionId, childId),
      sql`${projectSessions.metadata}->>${SUBAGENT_NOTIFY_PARENT_KEY} = 'true'`,
      inArray(projectSessions.status, ['provisioning', 'running']),
    ));
  if (kids.some((kid) => kid.status === 'provisioning')) return true;
  const working = await readSessionsWorking([childId, ...kids.map((kid) => kid.sessionId)]);
  return [...working.values()].some((state) => state.state === 'working');
}

/**
 * The child's final report: the newest assistant text after the last user
 * message (the turn that just ended), from the API's copy of its session log.
 * pi's turn-end relay flushes that log before it reports the turn end.
 */
async function readReport(child: ProjectSessionRow): Promise<{ text: string; error?: string }> {
  try {
    const transcript = await buildSessionTranscriptDigest({
      session: child,
      limit: READ_BACK_MESSAGES,
      maxChars: 700,
      full: true,
    });
    const messages = transcript.messages;
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const assistants = messages.slice(lastUser + 1).filter((m) => m.role === 'assistant');
    const last = assistants.at(-1);
    const text = [...assistants].reverse().find((m) => m.text.trim())?.text.trim() ?? '';
    const error = last?.error ? [last.error.name, last.error.message].filter(Boolean).join(': ') || 'the last turn failed' : undefined;
    return { text, ...(error ? { error } : {}) };
  } catch (err) {
    return { text: '', error: `its final report could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
}

async function deliver(
  child: ProjectSessionRow,
  parentId: string,
  turnKey: string,
  outcome: { status: SubagentNoticeStatus; report: string; error: string | null },
): Promise<boolean> {
  const parent = await loadSession(parentId);
  const parentMeta = (parent?.metadata ?? {}) as Record<string, unknown>;
  if (!parent || parent.projectId !== child.projectId || typeof parentMeta.deletedAt === 'string') return false;
  const childMeta = (child.metadata ?? {}) as Record<string, unknown>;
  const teammate = isTeammateRow(child)
    ? { handle: teamHandle(child), tasks: await tasksOwnedBy(child.sessionId).catch(() => []) }
    : null;
  const text = subagentNoticeText({
    childId: child.sessionId,
    status: outcome.status,
    agent: child.agentName,
    title: typeof childMeta.custom_name === 'string' ? childMeta.custom_name : null,
    report: outcome.report,
    error: outcome.error,
    teammate,
  });
  const key = `subagent-finished:${child.sessionId}:${turnKey}`;
  // Coalesced with every other notice still waiting for the parent; the row
  // steers into a running parent turn, else starts one (waking the box first).
  const { deduped, coalesced } = await enqueueSessionNotice({
    source: 'system:subagent-finished',
    projectId: parent.projectId,
    accountId: parent.accountId,
    sessionId: parent.sessionId,
    // The identity the child ran as: the person its parent acts for.
    actorUserId: child.createdBy,
    text,
    key,
    authorSessionId: child.sessionId,
  });
  logger.info('[subagent-notice] parent notified', { childId: child.sessionId, parentId, status: outcome.status, deduped, coalesced });
  return !deduped;
}
