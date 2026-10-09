// Who a session event is for (KRTX-1742 design §3.1, §3.2). projects/ owns
// the rows these read — the prompt commands, the live turn, the session row —
// so the answers travel on the notifier's event and notifications/ never
// imports projects/ internals. Every export here is background-safe and never
// throws: a failed read means "nobody extra", never a failed relay or route.
import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import type { SecretGrant, SharingIntent } from '../../connectors/share';
import { accountGroupsAmong, groupMemberRows } from '../../iam/group-read';
import { accountMembersAmong } from '../../iam/membership-read';
import { logger } from '../../lib/logger';
import { filterSessionRecipients, loadSessionAccessRows } from '../../notifications/access';
import { deliver, type DeliverInput } from '../../notifications/notifier';
import { sessionTitleOf, type SessionOriginClass, type SessionPushEvent } from '../../notifications/session-push';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { newestStoredTurn } from '../session-lifecycle/inbox-admission';
import { wireMessageIdMatches } from '../session-lifecycle/wire-id-match';
import { storedSandboxTurns } from '../session-turn-ledger';
import { triggerSlugOf } from './trigger-run-outcome';
import { resolveTriggerWatchers } from './trigger-watchers';
import { resolveUserIdentities } from './user-identity';

const CHANNELS = ['slack', 'teams', 'email', 'telegram'] as const;

export interface SessionClass {
  originClass: SessionOriginClass;
  /** A coordinator-spawned worker session. */
  isChild: boolean;
  /** The trigger that created the session (`trigger_kind: git`), else null. */
  triggerSlug: string | null;
}

/**
 * The origin class from the session row:
 * - channel: `metadata.source` is a chat channel, or its metadata block exists;
 * - unattended: a trigger created it, or `origin` is trigger or schedule;
 * - attended: anything else, a `system` origin with a human creator included.
 */
export function classifySession(metadata: unknown, origin: string | null | undefined): SessionClass {
  const meta = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  const channel = CHANNELS.some((name) => meta.source === name || (meta[name] !== null && typeof meta[name] === 'object'));
  const triggerSlug = triggerSlugOf(meta);
  const originClass: SessionOriginClass = channel
    ? 'channel'
    : triggerSlug !== null || origin === 'trigger' || origin === 'schedule'
      ? 'unattended'
      : 'attended';
  return { originClass, isChild: typeof meta.spawned_by_session === 'string', triggerSlug };
}

/**
 * The person whose prompt the turn with this wire message id answers: the
 * newest `continue_session` row the id names, when that row bound the turn to
 * a person (`bindTurnIdentity`) and no agent session wrote it. A trigger,
 * channel follow-up or agent prompt has no person prompter.
 */
export async function personPrompterOf(
  sessionId: string,
  accountId: string,
  messageId: string | null | undefined,
): Promise<string | null> {
  if (!messageId) return null;
  const [row] = await db
    .select({ actorUserId: sessionLifecycleCommands.actorUserId, payload: sessionLifecycleCommands.payload })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.sessionId, sessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        wireMessageIdMatches(messageId),
      ),
    )
    .orderBy(desc(sessionLifecycleCommands.createdAt))
    .limit(1);
  const payload = (row?.payload ?? {}) as Record<string, unknown>;
  if (!row?.actorUserId || payload.bindTurnIdentity !== true || payload.authorSessionId != null) return null;
  // An API key stands in for the account; it is not a person.
  return row.actorUserId === accountId ? null : row.actorUserId;
}

/** The person who prompted the session's running turn (the newest live turn). */
export async function runningTurnPrompter(sessionId: string, accountId: string): Promise<string | null> {
  const [box] = await db
    .select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  const turn = newestStoredTurn(storedSandboxTurns(box?.metadata));
  return personPrompterOf(sessionId, accountId, turn?.messageId);
}

export interface NotificationSessionRef {
  sessionId: string;
  projectId: string;
  accountId: string;
  metadata: unknown;
  origin: string | null | undefined;
}

type EventContext = Pick<SessionPushEvent, 'prompterUserId' | 'originClass' | 'isChild' | 'triggerWatcherIds'>;

async function orFallback<T>(read: () => Promise<T>, fallback: T, what: string, sessionId: string): Promise<T> {
  try {
    return await read();
  } catch (err) {
    logger.warn('[notify] recipient lookup failed', { what, sessionId, error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

/** The recipients' context of a turn end that names `turnMessageId`. */
export async function turnEndNotificationContext(
  session: NotificationSessionRef,
  turnMessageId: string | null,
): Promise<EventContext> {
  const { originClass, isChild } = classifySession(session.metadata, session.origin);
  const prompterUserId = await orFallback(
    () => personPrompterOf(session.sessionId, session.accountId, turnMessageId),
    null,
    'turn_prompter',
    session.sessionId,
  );
  return { prompterUserId, originClass, isChild };
}

/** The recipients' context of a question or permission ask of the running turn. */
export async function askNotificationContext(session: NotificationSessionRef): Promise<EventContext> {
  const { originClass, isChild, triggerSlug } = classifySession(session.metadata, session.origin);
  const [prompterUserId, triggerWatcherIds] = await Promise.all([
    orFallback(() => runningTurnPrompter(session.sessionId, session.accountId), null, 'running_turn_prompter', session.sessionId),
    originClass === 'unattended' && !isChild && triggerSlug
      ? orFallback(
          () => resolveTriggerWatchers({ accountId: session.accountId, projectId: session.projectId, slug: triggerSlug }),
          [] as string[],
          'trigger_watchers',
          session.sessionId,
        )
      : Promise.resolve([] as string[]),
  ]);
  return { prompterUserId, originClass, isChild, triggerWatcherIds };
}

export interface SessionShareChange {
  accountId: string;
  projectId: string;
  sessionId: string;
  sharerId: string;
  creatorId: string | null;
  /** The session's grants BEFORE `setSessionSharing` replaced them. */
  priorGrants: readonly SecretGrant[];
  intent: SharingIntent;
  now?: Date;
}

/**
 * "Shared with you" for the people a members share newly names (design §3.2):
 * the account's members and the members of the account's groups in the new
 * share, minus everyone the previous grants already named, the sharer and the
 * creator, minus anyone who cannot open the session after the change.
 * One row per person per session per UTC day, so toggling a share cannot
 * flood anyone. Returns the users told.
 */
export async function notifySessionShared(
  change: SessionShareChange,
  send: (input: DeliverInput) => Promise<unknown> = deliver,
): Promise<string[]> {
  if (change.intent.mode !== 'members') return [];
  try {
    const memberIds = (change.intent.memberIds ?? []).filter(isUuid);
    const groupIds = (change.intent.groupIds ?? []).filter(isUuid);
    const [members, groups] = await Promise.all([
      memberIds.length ? accountMembersAmong(change.accountId, memberIds) : [],
      groupIds.length ? accountGroupsAmong(change.accountId, groupIds) : [],
    ]);
    const priorGroupIds = change.priorGrants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
    const [groupMembers, priorGroupMembers] = await Promise.all([
      groups.length ? groupMemberRows(groups.map((g) => g.groupId)) : [],
      priorGroupIds.length ? groupMemberRows(priorGroupIds) : [],
    ]);
    const known = new Set<string | null>([
      ...change.priorGrants.filter((g) => g.principalType === 'member').map((g) => g.principalId),
      ...priorGroupMembers.map((row) => row.userId),
      change.sharerId,
      change.creatorId,
    ]);
    const candidates = [...new Set([...members, ...groupMembers].map((row) => row.userId))].filter((id) => !known.has(id));
    if (candidates.length === 0) return [];
    const session = (await loadSessionAccessRows([change.sessionId])).get(change.sessionId);
    if (!session) return [];
    const recipients = await filterSessionRecipients(session, candidates);
    if (recipients.length === 0) return [];
    const sharer = (await resolveUserIdentities([change.sharerId])).get(change.sharerId)?.displayName?.trim();
    await send({
      kind: 'shared',
      accountId: change.accountId,
      projectId: change.projectId,
      sessionId: change.sessionId,
      title: sessionTitleOf(session.metadata) ?? '',
      body: `${sharer || 'A teammate'} shared a session with you`,
      actorUserId: change.sharerId,
      dedupeKey: `shared:${change.sessionId}:${(change.now ?? new Date()).toISOString().slice(0, 10)}`,
      recipients,
    });
    return recipients;
  } catch (err) {
    logger.warn('[notify] shared-with-you failed', {
      sessionId: change.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
