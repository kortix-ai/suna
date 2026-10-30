/**
 * A background subagent's answer, delivered to the session that started it.
 *
 * kortixd's `agent` tool with `background: true` creates the child with
 * `notify_parent_on_turn_end: true` and returns at once
 * (`apps/kortix-sandbox-agent-server/src/harness/pi/cloud-subagent.ts`).
 * session-create.ts stores the flag on the child's metadata only for a
 * session-bound caller, so the parent is always `spawned_by_session`: the
 * caller itself. A client cannot write the key (session-metadata-keys.ts).
 *
 * When the child closes a turn, `settleTurnEnd` (routes/turn-stream-handlers.ts)
 * asks {@link subagentNoticeDue}, and {@link notifyParentOfSubagent} enqueues
 * ONE `continue_session` on the parent with a `<task-notification>` block: it
 * steers the parent's running turn, or waits as a queued prompt that wakes a
 * stopped parent (the delivery `connectors/notify-session.ts` uses). The flag
 * is cleared after the enqueue: one notification per background hand-off. The
 * idempotency key names the child and its turn, so a re-sent turn end
 * enqueues nothing new. Nothing here throws into the turn-end path.
 */
import type { TurnErrorCode } from '@kortix/api-contract/transcript';
import { projectSessions } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { mintWireMessageId } from '../wire-message-id';
import { promptModelOverride } from './prompt-model';

/** The child-metadata flag: notify `spawned_by_session` when this session's turn ends. */
export const SUBAGENT_NOTIFY_PARENT_KEY = 'notify_parent_on_turn_end';
/** Characters of the child's answer the notification carries. */
export const SUBAGENT_ANSWER_MAX_CHARS = 4_000;
/** Messages read back from the child's transcript to find its answer. */
const READ_BACK_MESSAGES = 20;

/**
 * The create-time half: a new session carries the flag only when a
 * session-bound caller (`callerSessionId`) asks for it, so the parent it
 * notifies is always that caller. Pure.
 */
export function subagentNotifyMetadata(callerSessionId: string | null | undefined, requested: unknown): Record<string, true> {
  return callerSessionId && requested === true ? { [SUBAGENT_NOTIFY_PARENT_KEY]: true } : {};
}

export interface SubagentNoticeDue {
  parentSessionId: string;
  idempotencyKey: string;
}

/**
 * Whether this turn end notifies the parent: a turn that closed in this call,
 * on a child that carries the flag and names a parent other than itself.
 * Pure: the caller settles the turn and reads the metadata.
 */
export function subagentNoticeDue(input: {
  childSessionId: string;
  metadata: Record<string, unknown>;
  /** The turn ledger's outcome for this end (`completeSandboxTurn`). */
  outcome: string;
  turnMessageId: string | null;
}): SubagentNoticeDue | null {
  if (input.outcome !== 'closed') return null;
  if (input.metadata[SUBAGENT_NOTIFY_PARENT_KEY] !== true) return null;
  const parent = input.metadata.spawned_by_session;
  if (typeof parent !== 'string' || !parent || parent === input.childSessionId) return null;
  return {
    parentSessionId: parent,
    idempotencyKey: `subagent-finished:${input.childSessionId}:${input.turnMessageId ?? 'turn'}`,
  };
}

interface CompactMessage {
  role?: string;
  text?: string | null;
  error?: unknown;
}

/**
 * The child's answer from its newest messages: the last assistant text after
 * the last user message (the turn that just ended), or the error of the last
 * assistant message when that one failed. kortixd's `readFinalText` reads the
 * same way. Pure.
 */
export function subagentAnswer(messages: CompactMessage[]): { text: string | null; error: string | null } {
  let lastUser = -1;
  messages.forEach((m, index) => {
    if (m.role === 'user') lastUser = index;
  });
  const turn = messages.slice(lastUser + 1);
  const assistants = turn.filter((m) => m.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last?.error) return { text: null, error: errorText(last.error) };
  const report = [...assistants].reverse().find((m) => typeof m.text === 'string' && m.text.trim());
  return { text: report?.text?.trim() ?? null, error: null };
}

/** The text as is, except a closing tag of this block: an answer cannot end the block it rides in. */
function inert(value: string): string {
  return value.replace(/<\/(task-notification|task-id|agent|title|status|error|result)>/gi, '<\\/$1>');
}

/** The notification the parent's model reads. Pure. */
export function subagentNoticeText(input: {
  childSessionId: string;
  agentName: string | null;
  title: string | null;
  status: 'completed' | 'failed' | 'stopped';
  answer: string | null;
  error: string | null;
}): string {
  const answer = input.answer ?? '';
  const cut = answer.length > SUBAGENT_ANSWER_MAX_CHARS;
  const result = cut
    ? `${answer.slice(0, SUBAGENT_ANSWER_MAX_CHARS)}\n… (${answer.length - SUBAGENT_ANSWER_MAX_CHARS} more characters: read the whole answer in session ${input.childSessionId})`
    : answer;
  const what = { completed: 'finished', failed: 'failed', stopped: 'was stopped' }[input.status];
  return [
    '<task-notification>',
    `<task-id>${input.childSessionId}</task-id>`,
    ...(input.agentName ? [`<agent>${inert(input.agentName)}</agent>`] : []),
    ...(input.title ? [`<title>${inert(input.title)}</title>`] : []),
    `<status>${input.status}</status>`,
    ...(input.error ? [`<error>${inert(input.error)}</error>`] : []),
    ...(result ? ['<result>', inert(result), '</result>'] : []),
    '</task-notification>',
    `The background subagent session ${input.childSessionId} ${what}. To continue it, call the agent tool with task_id: ${input.childSessionId}.`,
  ].join('\n');
}

/**
 * Enqueue the parent's notification for a due turn end, then clear the flag.
 * Reads the child's answer through the transcript digest (the child's box,
 * else its saved mirror). Never throws.
 */
export async function notifyParentOfSubagent(input: {
  due: SubagentNoticeDue;
  childSessionId: string;
  projectId: string;
  status: 'idle' | 'error';
  error?: { name?: string; message?: string; code?: TurnErrorCode };
}): Promise<void> {
  const { due, childSessionId, projectId } = input;
  try {
    // Loaded here: session-create.ts imports this module's key, and the lifecycle engine imports session-create.
    const [{ enqueueContinueSessionCommand, drainSessionLifecycleQueue }, { buildSessionTranscriptDigest }] = await Promise.all([
      import('../session-lifecycle'),
      import('./session-transcript'),
    ]);
    const [child] = await db.select().from(projectSessions)
      .where(and(eq(projectSessions.sessionId, childSessionId), eq(projectSessions.projectId, projectId))).limit(1);
    const [parent] = await db.select({
      accountId: projectSessions.accountId,
      createdBy: projectSessions.createdBy,
      metadata: projectSessions.metadata,
    }).from(projectSessions)
      .where(and(eq(projectSessions.sessionId, due.parentSessionId), eq(projectSessions.projectId, projectId))).limit(1);
    const parentMetadata = (parent?.metadata ?? {}) as Record<string, unknown>;
    if (!child || !parent || typeof parentMetadata.deletedAt === 'string') {
      await clearNotifyFlag(childSessionId);
      return;
    }
    const childMetadata = (child.metadata ?? {}) as Record<string, unknown>;
    const read = child.createdBy
      ? await buildSessionTranscriptDigest({
        session: child,
        limit: READ_BACK_MESSAGES,
        maxChars: 700,
        full: true,
      }).then((digest) => subagentAnswer(digest.messages as CompactMessage[]))
      : { text: null, error: null };
    const turnError = input.status === 'error' ? (input.error?.message ?? input.error?.name ?? 'The turn ended with an error.') : null;
    const status = input.error?.code === 'aborted' ? 'stopped' : turnError || read.error ? 'failed' : 'completed';
    const text = subagentNoticeText({
      childSessionId,
      agentName: child.agentName && child.agentName !== 'default' ? child.agentName : null,
      title: typeof childMetadata.custom_name === 'string' ? childMetadata.custom_name : null,
      status,
      answer: read.text,
      error: status === 'stopped' ? null : (read.error ?? turnError),
    });
    await enqueueContinueSessionCommand({
      source: 'system:subagent-finished',
      projectId,
      accountId: parent.accountId,
      sessionId: due.parentSessionId,
      actorUserId: parent.createdBy,
      text,
      // Harness context, not a person's words: the transcript shows it as a notice.
      parts: [{ type: 'text', text, synthetic: true }],
      idempotencyKey: due.idempotencyKey,
      // An automation row (no clientMessageId), like a room message: it steers a
      // running turn and otherwise wakes the parent for a turn of its own.
      delivery: 'steer',
      wireMessageId: mintWireMessageId({ nowMs: Date.now() }).id,
      remintOnDelivery: true,
      overrides: { agent: null, model: promptModelOverride(null, parentMetadata), variant: null, directory: null },
    });
    await clearNotifyFlag(childSessionId);
    drainSessionLifecycleQueue({ idempotencyKey: due.idempotencyKey, burst: false }).catch(() => {});
    logger.info('[subagent-notice] parent notified of a background subagent', {
      childSessionId,
      parentSessionId: due.parentSessionId,
      status,
    });
  } catch (err) {
    logger.warn('[subagent-notice] parent notification failed', {
      childSessionId,
      parentSessionId: due.parentSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** One notification per hand-off: drop the flag from the child's metadata. */
async function clearNotifyFlag(sessionId: string): Promise<void> {
  await db.update(projectSessions)
    .set({ metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) - ${SUBAGENT_NOTIFY_PARENT_KEY}::text` })
    .where(eq(projectSessions.sessionId, sessionId));
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    const message = data?.message ?? record.message ?? record.name;
    if (typeof message === 'string') return message;
    return JSON.stringify(err).slice(0, 300);
  }
  return String(err);
}
