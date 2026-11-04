/**
 * Private channels: who may see a channel and everything in it.
 *
 * One rule, `canSeeSpace`. A public channel, `#general` and a DM (its own
 * owner check lives in the DM queries) are seen by every project member. A
 * private channel is seen only by its members (`project_space_members`). A
 * session-bound agent/sandbox token sees only the private channel its own
 * thread is in, and only while its launcher is still a member (a trigger run
 * has no human launcher and keeps it): a `#general` thread launched by a
 * member never reaches that member's private channels, and a removed member's
 * copied token reaches nothing of the channel. A project manager
 * who is not a member does not see a private channel's content; the routes that let a manager archive, rename and remove
 * members check `project.members.manage` themselves.
 *
 * Account session oversight is not a space fact: the session rule
 * (`isProjectSessionVisibleTo`, `spaceVisible`) lets an overseeing admin open a
 * hidden thread, audited like any other oversight read.
 *
 * `hiddenSpaceIds` folds the rule over a project's private channels, once per
 * request: the session rules, the session list SQL and the read view filter by
 * it. No private channel can be made until `privateChannelsAvailable()` is on.
 */
import { projectSessions, projectSpaceMembers, projectSpaces } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from './db';
import { onSpaceAccessBustNotify, publishSpaceAccessBust } from './pg-broadcast';
import { qualifiedColumn } from './sql-qualified-column';
import { ttlMemo } from './ttl-memo';

/**
 * Whether a private channel may be created or a channel made private. Off
 * (the default): create and convert answer 409 `private_channels_unavailable`,
 * so no private row exists that an older API build would show to everyone.
 * Turned on per deployment with `KORTIX_PRIVATE_CHANNELS_ENABLED=true`, never
 * in code, once the oldest deployed build enforces private channels and phase
 * 2 (Drive folder, memory, link unfurl, UI) has shipped. Tests write private
 * rows directly.
 */
export function privateChannelsAvailable(): boolean {
  return config.KORTIX_PRIVATE_CHANNELS_ENABLED === true;
}

export const PRIVATE_CHANNELS_UNAVAILABLE = {
  error: 'Private channels are not available yet.',
  code: 'private_channels_unavailable',
} as const;

type SpaceFacts = {
  spaceId: string;
  kind: 'channel' | 'dm';
  visibility: 'public' | 'private';
  isDefault: boolean;
};

/** What decides a viewer's private channels: their memberships, or the bound token's own thread's channel. */
export type SpaceAccess = {
  userId: string;
  /** The session-bound credential's session (`callerKortixSessionId`), null for a person. */
  bound: string | null;
  /** The channel of the bound session, null when unbound or in no space. */
  boundSpaceId: string | null;
  /** The bound session is a trigger run (`initiator_type = 'trigger'`): no human launcher whose membership decides. */
  boundAutomation: boolean;
  /** The private channels of the project the person (a bound token's launcher) is in. */
  memberOf: ReadonlySet<string>;
};

/** The one rule. */
export function canSeeSpace(space: SpaceFacts, access: SpaceAccess): boolean {
  if (space.visibility !== 'private' || space.kind !== 'channel' || space.isDefault) return true;
  if (access.bound !== null) {
    return access.boundSpaceId === space.spaceId && (access.boundAutomation || access.memberOf.has(space.spaceId));
  }
  return access.memberOf.has(space.spaceId);
}

type ProjectSpaceAccess = { access: SpaceAccess; privateSpaces: SpaceFacts[] };

const loadProjectSpaceAccess = ttlMemo({
  // Per-replica 10 s memo. A membership write busts it on every replica
  // (`bustSpaceAccess`, over LISTEN/NOTIFY); the TTL is the backstop when the
  // LISTEN is down.
  ttlMs: 10_000,
  keyFn: (projectId: string, userId: string, bound: string | null) => `${projectId}|${userId}|${bound ?? '-'}`,
  loader: async (projectId: string, userId: string, bound: string | null): Promise<ProjectSpaceAccess> => {
    const [rows, boundRow] = await Promise.all([
      db
        .select({
          spaceId: projectSpaces.spaceId,
          kind: projectSpaces.kind,
          visibility: projectSpaces.visibility,
          isDefault: projectSpaces.isDefault,
          // Qualified: a bare column inside the subquery would bind to `m.space_id`.
          member: sql<boolean>`exists (select 1 from ${projectSpaceMembers} m where m.space_id = ${qualifiedColumn(projectSpaces.spaceId)} and m.user_id = ${userId}::uuid)`,
        })
        .from(projectSpaces)
        .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.visibility, 'private'))),
      bound
        ? db
            .select({ spaceId: projectSessions.spaceId, initiatorType: projectSessions.initiatorType })
            .from(projectSessions)
            .where(and(eq(projectSessions.sessionId, bound), eq(projectSessions.projectId, projectId)))
            .limit(1)
        : Promise.resolve([]),
    ]);
    return {
      privateSpaces: rows,
      access: {
        userId,
        bound,
        boundSpaceId: boundRow[0]?.spaceId ?? null,
        boundAutomation: boundRow[0]?.initiatorType === 'trigger',
        memberOf: new Set(rows.filter((row) => row.member).map((row) => row.spaceId)),
      },
    };
  },
});

/** The caller's access facts in a project. `bound`: `callerKortixSessionId(c)`. */
export async function spaceAccessFor(projectId: string, userId: string, bound: string | null): Promise<SpaceAccess> {
  return (await loadProjectSpaceAccess(projectId, userId, bound)).access;
}

/** The project's channels (archived included) the caller may not see. Empty in a project with no private channel. */
export async function hiddenSpaceIds(projectId: string, userId: string, bound: string | null): Promise<Set<string>> {
  const { access, privateSpaces } = await loadProjectSpaceAccess(projectId, userId, bound);
  return new Set(privateSpaces.filter((space) => !canSeeSpace(space, access)).map((space) => space.spaceId));
}

/**
 * The project's private channels (archived included) and, of them, the ones the
 * caller may not see. The same memoized read as `hiddenSpaceIds`.
 */
export async function privateChannelAccess(
  projectId: string,
  userId: string,
  bound: string | null,
): Promise<{ all: ReadonlySet<string>; hidden: ReadonlySet<string> }> {
  const { access, privateSpaces } = await loadProjectSpaceAccess(projectId, userId, bound);
  const channels = privateSpaces.filter((space) => space.kind === 'channel' && !space.isDefault);
  return {
    all: new Set(channels.map((space) => space.spaceId)),
    hidden: new Set(channels.filter((space) => !canSeeSpace(space, access)).map((space) => space.spaceId)),
  };
}

/**
 * The project's private channel ids, for the open-stream re-check only: a
 * project with none (every project while `KORTIX_PRIVATE_CHANNELS_ENABLED` is
 * off) answers from memory, so its re-checks run no query. Busted with the
 * access memo on every replica; 5 min is the backstop when the LISTEN is down.
 */
const projectPrivateChannelIds = ttlMemo({
  ttlMs: 5 * 60_000,
  keyFn: (projectId: string) => `${projectId}|`,
  loader: async (projectId: string): Promise<ReadonlySet<string>> => {
    const rows = await db
      .select({ spaceId: projectSpaces.spaceId })
      .from(projectSpaces)
      .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'channel'), eq(projectSpaces.visibility, 'private')));
    return new Set(rows.map((row) => row.spaceId));
  },
});

/**
 * The periodic access re-check of an open session stream (`/events` SSE, a
 * proxied runtime event stream, a terminal or preview WebSocket), wrapped so
 * every transport behaves the same:
 *
 * - The project has no private channel: allowed, with no query. A deleted
 *   session or a revoked share then ends the stream when it reconnects, as
 *   before the re-check existed.
 * - Otherwise `check` decides. When it fails (a DB or pool error), the stream
 *   closes only if the session is in a private channel (fail closed: a removed
 *   member must not keep reading), and stays open otherwise (a transient error
 *   never drops an ordinary session's terminal or stream).
 *
 * The returned function never rejects. "In a private channel" is the last
 * answer read; unknown while the project is known to have private channels
 * counts as in one.
 */
export function sessionStreamAccessCheck(projectId: string, sessionId: string, check: () => Promise<boolean>): () => Promise<boolean> {
  let projectHasPrivate: boolean | null = null;
  let inPrivate: boolean | null = null;
  return async () => {
    let privateIds: ReadonlySet<string>;
    try {
      privateIds = await projectPrivateChannelIds(projectId);
    } catch {
      return !(inPrivate ?? projectHasPrivate ?? false);
    }
    projectHasPrivate = privateIds.size > 0;
    if (!projectHasPrivate) {
      inPrivate = false;
      return true;
    }
    const [verdict, space] = await Promise.allSettled([
      check(),
      db.select({ spaceId: projectSessions.spaceId }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1),
    ]);
    if (space.status === 'fulfilled') inPrivate = !!space.value[0]?.spaceId && privateIds.has(space.value[0].spaceId);
    if (verdict.status === 'fulfilled') return verdict.value;
    return !(inPrivate ?? true);
  };
}

/** A session's `spaceVisible` from `hiddenSpaceIds`. */
export function spaceVisibleFor(hidden: ReadonlySet<string>, spaceId: string | null | undefined): boolean {
  return !spaceId || !hidden.has(spaceId);
}

// replica-local: callbacks of the modules that cache a verdict built on space access (the proxy's).
const bustListeners = new Set<() => void>();

/** Run `listener` on every `bustSpaceAccess`. */
export function onSpaceAccessBust(listener: () => void): void {
  bustListeners.add(listener);
}

function bustSpaceAccessLocal(projectId: string): void {
  loadProjectSpaceAccess.invalidateByPrefix(`${projectId}|`);
  projectPrivateChannelIds.invalidateByPrefix(`${projectId}|`);
  for (const listener of bustListeners) {
    try {
      listener();
    } catch {
      // A listener must not stop the others.
    }
  }
}

// A bust announced by another replica (or echoed from this one; busting is idempotent).
onSpaceAccessBustNotify(bustSpaceAccessLocal);

/**
 * Drop the cached access for a project, and the proxy verdicts built on it,
 * on this replica at once and on every other replica over LISTEN/NOTIFY
 * (`kortix_space_access_bust`): after a membership change, a private create
 * or a conversion. Without the LISTEN the other replicas catch up within the
 * memo TTL.
 */
export function bustSpaceAccess(projectId: string): void {
  bustSpaceAccessLocal(projectId);
  publishSpaceAccessBust(projectId);
}

/** The members of `spaceId` when it is a private channel; null for a public space or no space. */
export async function privateSpaceMemberIds(spaceId: string | null | undefined): Promise<Set<string> | null> {
  if (!spaceId) return null;
  const rows = await db
    .select({ userId: projectSpaceMembers.userId, visibility: projectSpaces.visibility })
    .from(projectSpaces)
    .leftJoin(projectSpaceMembers, eq(projectSpaceMembers.spaceId, projectSpaces.spaceId))
    .where(eq(projectSpaces.spaceId, spaceId));
  if (rows[0]?.visibility !== 'private') return null;
  return new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])));
}

/** Of `sessionIds`, the sessions of `projectId` filed in one of the `hidden` channels. One read; none when `hidden` is empty. */
export async function sessionsInSpaces(
  projectId: string,
  sessionIds: readonly string[],
  hidden: ReadonlySet<string>,
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0 || hidden.size === 0) return new Set();
  const rows = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), inArray(projectSessions.sessionId, ids), inArray(projectSessions.spaceId, [...hidden])));
  return new Set(rows.map((row) => row.sessionId));
}

type AuditLikeRow = {
  projectId: string | null;
  sessionId: string | null;
  inputSummary: unknown;
  outputSummary: unknown;
  before: unknown;
  after: unknown;
};

/**
 * Audit rows of private channels' threads the viewer may not see keep their
 * metadata (who, what action, when, outcome) and lose their content: tool
 * input and output summaries, before and after. With a free-text search the rows go entirely: a match would say what
 * the hidden content holds.
 */
export async function redactHiddenChannelAuditRows<T extends AuditLikeRow>(
  rows: T[],
  viewer: { userId: string; bound: string | null },
  opts: { searching: boolean },
): Promise<T[]> {
  const byProject = new Map<string, string[]>();
  for (const row of rows) {
    if (row.projectId && row.sessionId) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row.sessionId]);
  }
  const hiddenSessions = new Set<string>();
  for (const [projectId, sessionIds] of byProject) {
    const hidden = await hiddenSpaceIds(projectId, viewer.userId, viewer.bound);
    for (const id of await sessionsInSpaces(projectId, sessionIds, hidden)) hiddenSessions.add(id);
  }
  if (hiddenSessions.size === 0) return rows;
  const isHidden = (row: T) => row.sessionId !== null && hiddenSessions.has(row.sessionId);
  if (opts.searching) return rows.filter((row) => !isHidden(row));
  return rows.map((row) => (isHidden(row) ? { ...row, inputSummary: null, outputSummary: null, before: null, after: null } : row));
}
