// Trigger watchers (KRTX-1742): who gets a trigger's failure and recovery
// alerts. The person who created or last edited a trigger through the API
// follows it; a reminder's creator follows it implicitly through
// `project_trigger_runtime.owner_user_id`. A muted row silences one user.
import { and, eq, sql } from 'drizzle-orm';
import { projectTriggerRuntime, triggerWatchers } from '@kortix/db';
import { projectManagerUserIds } from '../../iam/project-managers';
import { filterSessionRecipients, filterTriggerRecipients, loadSessionAccessRows } from '../../notifications/access';
import { db } from '../../shared/db';

export interface TriggerRef {
  accountId: string;
  projectId: string;
  slug: string;
}

/** The request's credential, as the auth middleware set it. */
export interface WatcherCredential {
  authType?: string | null;
  userId?: string | null;
  /** A JWT's sign-in id, or the session a PAT is bound to. */
  sessionId?: string | null;
  /** The person an agent-session token acts for. */
  onBehalfOfUserId?: string | null;
}

/**
 * The person a create or edit is recorded for, or null. A browser or app
 * sign-in and a personal CLI token name their user; an agent session token
 * names the person it acts for. An API key carries the account id and a
 * service account its own id: neither is a person.
 */
export function triggerWatcherOf(credential: WatcherCredential): string | null {
  if (credential.authType === 'supabase') return credential.userId || null;
  if (credential.authType !== 'pat') return null;
  if (credential.sessionId) return credential.onBehalfOfUserId || null;
  return credential.userId || null;
}

/** Of `ids`, the users who may receive this notification now. */
export type RecipientFilter = (ids: readonly string[]) => Promise<string[]>;

/**
 * The users to notify for this trigger, already access-checked by
 * `canReceive` (default: may read the project's triggers): unmuted watcher
 * rows plus the implicit `project_trigger_runtime.owner_user_id`; when none
 * of them passes (and no muted watcher passes), the project managers.
 *
 * A reminder's name is free text about its session, so a reminder's users
 * must also be able to open that session. When the session is gone, only
 * the reminder's own users hear: the managers never learned of it.
 */
export async function resolveTriggerWatchers(
  ref: TriggerRef,
  canReceive: RecipientFilter = (ids) => filterTriggerRecipients(ref.accountId, ref.projectId, ids),
): Promise<string[]> {
  const [rows, [runtime]] = await Promise.all([
    db
      .select({ userId: triggerWatchers.userId, muted: triggerWatchers.muted })
      .from(triggerWatchers)
      .where(and(eq(triggerWatchers.projectId, ref.projectId), eq(triggerWatchers.slug, ref.slug))),
    db
      .select({
        ownerUserId: projectTriggerRuntime.ownerUserId,
        reminder: sql<boolean>`${projectTriggerRuntime.scheduleSpec} ->> 'reminder' is not null`,
        pinnedSessionId: sql<string | null>`${projectTriggerRuntime.scheduleSpec} ->> 'pinnedSessionId'`,
      })
      .from(projectTriggerRuntime)
      .where(and(eq(projectTriggerRuntime.projectId, ref.projectId), eq(projectTriggerRuntime.slug, ref.slug)))
      .limit(1),
  ]);
  const muted = rows.filter((row) => row.muted).map((row) => row.userId);
  const candidates = rows.filter((row) => !row.muted).map((row) => row.userId);
  const owner = runtime?.ownerUserId;
  if (owner && !muted.includes(owner)) candidates.push(owner);

  let gate = canReceive;
  if (runtime?.reminder) {
    const pinned = runtime.pinnedSessionId;
    const session = pinned ? (await loadSessionAccessRows([pinned])).get(pinned) : undefined;
    if (!session || typeof (session.metadata as { deletedAt?: unknown } | null)?.deletedAt === 'string') {
      return canReceive(candidates);
    }
    gate = async (ids) => filterSessionRecipients(session, await canReceive(ids));
  }

  const passing = await gate(candidates);
  if (passing.length > 0) return passing;
  // Someone who can still see the trigger chose silence: respect it.
  if ((await gate(muted)).length > 0) return [];
  // Nobody follows it any more (a demoted creator, an API-created trigger):
  // the people who can fix it hear about it.
  return gate(await projectManagerUserIds(ref.accountId, ref.projectId));
}

/** The caller created or edited the trigger: follow it. Never un-mutes. */
export async function upsertTriggerWatcher(ref: TriggerRef & { userId: string }): Promise<void> {
  await db
    .insert(triggerWatchers)
    .values({ projectId: ref.projectId, slug: ref.slug, userId: ref.userId, muted: false })
    .onConflictDoUpdate({
      target: [triggerWatchers.projectId, triggerWatchers.slug, triggerWatchers.userId],
      set: { updatedAt: sql`now()` },
    });
}

/** The trigger was deleted: drop its watcher rows. */
export async function deleteTriggerWatchers(ref: Omit<TriggerRef, 'accountId'>): Promise<void> {
  await db
    .delete(triggerWatchers)
    .where(and(eq(triggerWatchers.projectId, ref.projectId), eq(triggerWatchers.slug, ref.slug)));
}
