/**
 * Project spaces: channels (product word "Channel") and a member's DMs with one
 * agent, one table `kortix.project_spaces`. A thread is a `project_sessions` row
 * whose `space_id` points here. Behind the `project_channels` flag; the routes
 * live in `routes/project-spaces.ts`.
 *
 * Only `ensureDefaultSpace` ever sets `is_default`. Channel slugs are unique per
 * project INCLUDING archived channels, so a clash with an archived channel
 * answers 409 with `archived: true`, and with `can_edit` the client offers to
 * unarchive it.
 *
 * A private channel (`visibility`) exists only for its members
 * (`space-access.ts`): every lookup here that reaches a channel for a caller
 * takes the caller's `SpaceAccess`, and a channel the caller may not see reads
 * as not found. A taken slug's 409 never names a hidden channel.
 */
import type { PrivateChannelSummary, Space, SpaceCreateInput, SpaceUpdateInput } from '@kortix/api-contract';
import { projectSessions, projectSpaceLinks, projectSpaceMembers, projectSpaces } from '@kortix/db';
import { spaceSlug } from '@kortix/shared';
import { type SQL, and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import { recordAuditEvent } from '../../shared/audit';
import { loadProjectRosterIds } from './project-access-view';
import { uniqueViolationConstraint } from '../../shared/postgres-errors';
import { insertSpaceMembers, memberDisplayName, nonProjectMembers } from './project-space-members';
import { resolveUserIdentities } from './user-identity';
import { bustSpaceAccess, canSeeSpace, type SpaceAccess } from '../../shared/space-access';
import { normalizeString } from './serializers';

// Lazy: the drives service stays off the static import graph of every session
// create, trigger and member offboard that reaches this module.
const spaceFolders = () => import('../../drives/space-folders');

type SpaceRow = typeof projectSpaces.$inferSelect;

export type SpaceError = {
  status: 400 | 403 | 404 | 409 | 503;
  body: { error: string; code: string; space_id?: string; archived?: boolean; can_edit?: boolean };
};
/** `renamedFrom`: the slug a rename replaced. `converted`: the channel became private. */
export type SpaceResult = { space: SpaceRow; renamedFrom?: string; converted?: true } | { error: SpaceError };

const DEFAULT_SLUG = 'general';
const SLUG_INDEX = 'uniq_project_spaces_channel_slug';
const ASSIGN_BATCH = 1_000;
/**
 * `metadata.first_prompt`: what a channel timeline shows as the thread's top
 * message. `SERVER_FIRST_PROMPT_MAX_CHARS` in
 * `packages/ui/src/workspace/spaces/space-timeline.ts` mirrors it: a prompt this
 * long reads as cut there, and its "Show more" opens the thread.
 */
export const FIRST_PROMPT_MAX_CHARS = 500;

/**
 * Who reads a space: a project manager (`project.members.manage`, never a
 * session-bound token) may edit every channel. `access` decides which private
 * channels exist for them.
 */
export type SpaceViewer = { userId: string; manager: boolean; access: SpaceAccess };

/** A channel is edited by its creator or a project manager, the rule a channel link's delete follows. A DM is never edited. */
function canEditSpace(row: SpaceRow, viewer: SpaceViewer): boolean {
  return row.kind === 'channel' && (viewer.manager || row.createdBy === viewer.userId);
}

/** `isMember`: the viewer is in it (`project-space-members.ts`); `#general` and a DM are always true. */
export function serializeSpace(row: SpaceRow, viewer: SpaceViewer, isMember: boolean): Space {
  return {
    space_id: row.spaceId,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    description: row.description,
    is_default: row.isDefault,
    dm_agent_name: row.dmAgentName,
    archived_at: row.archivedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    can_edit: canEditSpace(row, viewer),
    agents: row.agents,
    is_member: row.kind === 'dm' || row.isDefault || isMember,
    visibility: row.visibility,
  };
}

async function findDefaultSpace(projectId: string): Promise<SpaceRow | null> {
  const [row] = await db
    .select()
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.isDefault, true)))
    .limit(1);
  return row ?? null;
}

/** The project's `#general`, and whether this call created it. Idempotent under concurrency. */
async function ensureDefaultSpaceCreated(projectId: string, accountId: string): Promise<{ space: SpaceRow; created: boolean }> {
  const existing = await findDefaultSpace(projectId);
  if (existing) return { space: existing, created: false };
  const [inserted] = await db
    .insert(projectSpaces)
    .values({ accountId, projectId, kind: 'channel', slug: DEFAULT_SLUG, name: DEFAULT_SLUG, isDefault: true })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { space: inserted, created: true };
  const raced = await findDefaultSpace(projectId);
  if (!raced) throw new Error(`project ${projectId} has no default space and '${DEFAULT_SLUG}' is taken`);
  return { space: raced, created: false };
}

/**
 * The project's `#general`, created on first call. Idempotent under
 * concurrency. The call that creates it also files every session that is in
 * no space into it, so every path that needs `#general` (the toggle effect, a
 * channel list, a session create, a warm claim) converges a project whose
 * toggle effect failed before `#general` existed. No later call checks again.
 * It also makes `#general`'s Files folder, best effort and off the
 * caller's path (the Files tab makes it on open when this fails).
 */
export async function ensureDefaultSpace(projectId: string, accountId: string): Promise<SpaceRow> {
  const general = await ensureDefaultSpaceCreated(projectId, accountId);
  if (general.created) {
    void spaceFolders().then((m) => m.makeChannelFolders(accountId, projectId, DEFAULT_SLUG));
    await assignUnassignedSessions(projectId, general.space.spaceId);
  }
  return general.space;
}

/**
 * The turn-on step of `project_channels`: `#general` (made if missing) and every
 * session in no space filed into it. `generalCreatedAt` tells a first turn-on
 * from a turn-on again (the caller compares it with the flag write's time).
 */
export async function turnOnChannels(projectId: string, accountId: string): Promise<{ generalCreatedAt: Date; filed: number }> {
  const general = await ensureDefaultSpaceCreated(projectId, accountId);
  if (general.created) void spaceFolders().then((m) => m.makeChannelFolders(accountId, projectId, DEFAULT_SLUG));
  const filed = await assignUnassignedSessions(projectId, general.space.spaceId);
  return { generalCreatedAt: general.space.createdAt, filed };
}

/**
 * A warm session claimed while `project_channels` is on is a new `#general`
 * thread, as a create without `space_id` is (a warm session is created outside
 * any space). Returns the `#general` id (null while the flag is off), the
 * columns the claim sets (a space the row already has wins) and the metadata
 * that carries the first prompt.
 */
export async function warmClaimFiling(
  project: { projectId: string; accountId: string; metadata: unknown },
  promptText: unknown,
): Promise<{ defaultSpaceId: string | null; columns: { spaceId?: SQL }; metadata: { first_prompt?: string } }> {
  if (!resolveFeatureFlag(project.metadata, 'project_channels')) {
    return { defaultSpaceId: null, columns: {}, metadata: {} };
  }
  const { spaceId } = await ensureDefaultSpace(project.projectId, project.accountId);
  const firstPrompt = normalizeString(promptText);
  return {
    defaultSpaceId: spaceId,
    columns: { spaceId: sql`coalesce(${projectSessions.spaceId}, ${spaceId}::uuid)` },
    metadata: firstPrompt ? { first_prompt: firstPrompt.slice(0, FIRST_PROMPT_MAX_CHARS) } : {},
  };
}

/** Live channels the caller may see (default first, then oldest first), then the caller's DMs. */
export async function listSpacesForUser(projectId: string, accountId: string, access: SpaceAccess): Promise<SpaceRow[]> {
  await ensureDefaultSpace(projectId, accountId);
  const rows = await db
    .select()
    .from(projectSpaces)
    .where(
      and(
        eq(projectSpaces.projectId, projectId),
        isNull(projectSpaces.archivedAt),
        or(eq(projectSpaces.kind, 'channel'), eq(projectSpaces.dmUserId, access.userId)),
      ),
    )
    .orderBy(asc(projectSpaces.kind), desc(projectSpaces.isDefault), asc(projectSpaces.createdAt), asc(projectSpaces.spaceId));
  return rows.filter((row) => canSeeSpace(row, access));
}

function invalidName(): { error: SpaceError } {
  return {
    error: { status: 400, body: { error: 'The name needs at least one letter or digit.', code: 'invalid_name' } },
  };
}

/**
 * 409 naming the channel that holds `slug`, whether it is archived, and whether
 * the viewer may edit it. A private channel the viewer may not see is named by
 * nothing but the taken name: no id, no archived state, no edit right.
 */
async function slugTaken(projectId: string, slug: string, viewer: SpaceViewer): Promise<{ error: SpaceError }> {
  const [found] = await db
    .select()
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'channel'), eq(projectSpaces.slug, slug)))
    .limit(1);
  const holder = found && canSeeSpace(found, viewer.access) ? found : undefined;
  if (found && !holder) {
    return { error: { status: 409, body: { error: `A channel is already named #${slug}.`, code: 'slug_taken' } } };
  }
  const archived = Boolean(holder?.archivedAt);
  return {
    error: {
      status: 409,
      body: {
        error: archived ? `An archived channel is already named #${slug}.` : `A channel is already named #${slug}.`,
        code: 'slug_taken',
        ...(holder ? { space_id: holder.spaceId, can_edit: canEditSpace(holder, viewer) } : {}),
        archived,
      },
    },
  };
}

export async function createChannel(
  projectId: string,
  accountId: string,
  viewer: SpaceViewer,
  input: SpaceCreateInput,
): Promise<SpaceResult> {
  const slug = spaceSlug(input.name);
  if (!slug) return invalidName();
  const outsiders = await nonProjectMembers({ projectId, accountId }, input.member_ids ?? []);
  if (outsiders.length > 0) {
    return {
      error: {
        status: 400,
        body: { error: 'Only members of the project can be added to a channel.', code: 'not_project_member' },
      },
    };
  }
  // `#general` first, so a new channel can never take its slug before it exists.
  await ensureDefaultSpace(projectId, accountId);
  try {
    const [row] = await db
      .insert(projectSpaces)
      .values({
        accountId,
        projectId,
        kind: 'channel',
        slug,
        name: input.name,
        description: input.description || null,
        createdBy: viewer.userId,
        visibility: input.visibility ?? 'public',
      })
      .returning();
    // The creator is a member, then the people they picked. Not in one
    // transaction with the insert: a failed member write leaves a public
    // channel whose creator re-adds people from the Members tab. A private
    // channel with no member is visible to nobody, so it is deleted instead.
    try {
      await insertSpaceMembers(row!.spaceId, [viewer.userId, ...(input.member_ids ?? [])], viewer.userId);
    } catch (error) {
      if (row!.visibility === 'private') await db.delete(projectSpaces).where(eq(projectSpaces.spaceId, row!.spaceId));
      throw error;
    }
    bustSpaceAccess(projectId);
    return { space: row! };
  } catch (error) {
    if (uniqueViolationConstraint(error) !== SLUG_INDEX) throw error;
    return slugTaken(projectId, slug, viewer);
  }
}

/** The 404 body for a space the caller cannot use: unknown, archived, or another member's DM. */
export const SPACE_NOT_FOUND = { error: 'Channel not found', code: 'space_not_found' };

function spaceNotFound(): { error: SpaceError } {
  return { error: { status: 404, body: SPACE_NOT_FOUND } };
}

/**
 * The space a new session may be filed into: a live channel of the project or
 * the caller's own live DM. Anything else, including another member's DM,
 * reads as not found so a DM's existence is never disclosed.
 */
export async function findSessionSpace(projectId: string, spaceId: string, access: SpaceAccess): Promise<SpaceRow | null> {
  const userId = access.userId;
  const [row] = await db
    .select()
    .from(projectSpaces)
    .where(
      and(
        eq(projectSpaces.projectId, projectId),
        eq(projectSpaces.spaceId, spaceId),
        isNull(projectSpaces.archivedAt),
        or(eq(projectSpaces.kind, 'channel'), eq(projectSpaces.dmUserId, userId)),
      ),
    )
    .limit(1);
  return row && canSeeSpace(row, access) ? row : null;
}

/**
 * The private channels of the project the viewer is not in, archived ones too:
 * the manager list. Name, member count (project people
 * only, as the Members tab counts) and creator; nothing the channel holds.
 */
export async function listHiddenPrivateChannels(
  project: { accountId: string; projectId: string },
  access: SpaceAccess,
): Promise<PrivateChannelSummary[]> {
  const rows = (
    await db
      .select()
      .from(projectSpaces)
      .where(and(eq(projectSpaces.projectId, project.projectId), eq(projectSpaces.visibility, 'private')))
      .orderBy(asc(projectSpaces.createdAt))
  ).filter((row) => !canSeeSpace(row, access));
  if (rows.length === 0) return [];
  const [members, roster, identities] = await Promise.all([
    db
      .select({ spaceId: projectSpaceMembers.spaceId, userId: projectSpaceMembers.userId })
      .from(projectSpaceMembers)
      .where(inArray(projectSpaceMembers.spaceId, rows.map((row) => row.spaceId))),
    loadProjectRosterIds({ row: project }),
    resolveUserIdentities(rows.flatMap((row) => (row.createdBy ? [row.createdBy] : []))),
  ]);
  const people = new Set(roster.ids);
  return rows.map((row) => {
    const creator = row.createdBy ? identities.get(row.createdBy) : undefined;
    return {
      space_id: row.spaceId,
      name: row.name,
      slug: row.slug ?? row.name,
      member_count: members.filter((m) => m.spaceId === row.spaceId && people.has(m.userId)).length,
      created_by: row.createdBy,
      created_by_name: creator?.exists ? memberDisplayName({ displayName: creator.displayName ?? null, email: creator.email ?? null }) || null : null,
      created_at: row.createdAt.toISOString(),
      archived_at: row.archivedAt?.toISOString() ?? null,
    };
  });
}

/** A channel's agents in order (the first is its default), or the project default when it lists none. */
export function channelAgentNames(space: Pick<SpaceRow, 'agents'>, projectDefault: string | null): string[] {
  const agents = space.agents ?? [];
  return agents.length > 0 ? [...agents] : projectDefault ? [projectDefault] : [];
}

/**
 * A live channel of the project; a DM, an archived or a foreign channel is
 * null. It does not check `canSeeSpace`: a caller-facing route does (the
 * routes' `loadChannel`).
 */
export async function findLiveChannel(projectId: string, spaceId: string): Promise<SpaceRow | null> {
  const [row] = await db
    .select()
    .from(projectSpaces)
    .where(
      and(
        eq(projectSpaces.projectId, projectId),
        eq(projectSpaces.spaceId, spaceId),
        eq(projectSpaces.kind, 'channel'),
        isNull(projectSpaces.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

type SessionVisibility = 'private' | 'project' | 'restricted';

/**
 * The sharing of a session filed into a space. A DM thread is private. A fork
 * keeps its source's sharing and never widens it: project-visible only when
 * its source is (a restricted source's grants are not copied, so its fork is
 * private). A new channel thread is project-visible.
 */
export function spaceSessionVisibility(kind: 'channel' | 'dm', forkSourceVisibility?: SessionVisibility | null): SessionVisibility {
  if (kind === 'dm') return 'private';
  if (forkSourceVisibility == null) return 'project';
  return forkSourceVisibility === 'project' ? 'project' : 'private';
}

/** A fork source's sharing; null when the source is not a session of this project. */
export async function forkSourceVisibility(projectId: string, sourceSessionId: string): Promise<SessionVisibility | null> {
  const [source] = await db
    .select({ visibility: projectSessions.visibility })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sourceSessionId)))
    .limit(1);
  return (source?.visibility as SessionVisibility | undefined) ?? null;
}

/** A fork source's space, when the caller may file a session into it, and the source's sharing. */
export async function findForkSourceSpace(
  projectId: string,
  sourceSessionId: string,
  access: SpaceAccess,
): Promise<{ space: SpaceRow; visibility: SessionVisibility } | null> {
  const [source] = await db
    .select({ spaceId: projectSessions.spaceId, visibility: projectSessions.visibility })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sourceSessionId)))
    .limit(1);
  const space = source?.spaceId ? await findSessionSpace(projectId, source.spaceId, access) : null;
  return space ? { space, visibility: source!.visibility as SessionVisibility } : null;
}

/**
 * A fork or a child of a private channel's thread stays in that channel
 *: the fork copies the source's transcript, and a child
 * gets whatever its parent hands it. `null`: neither source is in a private
 * channel, the ordinary filing applies. A caller who may not see the channel
 * gets 404 (account oversight reads a thread, it never posts one). Another
 * `space_id` is 400 `private_channel_fork`.
 */
export async function inheritedPrivateSpace(
  projectId: string,
  input: {
    forkFromSessionId: unknown;
    /** The bound caller's own session: the parent of what its agent spawns. */
    parentSessionId: string | null;
    /** A person's `parent_session_id`. */
    bodyParentSessionId: unknown;
    requestedSpaceId: unknown;
  },
  access: SpaceAccess,
): Promise<{ spaceId: string } | { error: SpaceError } | null> {
  const ids = [input.forkFromSessionId, input.parentSessionId, input.bodyParentSessionId].filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return null;
  const rows = await db
    .select({ space: projectSpaces })
    .from(projectSessions)
    .innerJoin(projectSpaces, eq(projectSpaces.spaceId, projectSessions.spaceId))
    .where(and(eq(projectSessions.projectId, projectId), inArray(projectSessions.sessionId, ids), eq(projectSpaces.visibility, 'private')));
  const spaces = [...new Map(rows.map((row) => [row.space.spaceId, row.space])).values()];
  if (spaces.length === 0) return null;
  const forkRefused = {
    error: {
      status: 400 as const,
      body: { error: 'A thread of a private channel can only be forked or continued inside that channel.', code: 'private_channel_fork' },
    },
  };
  if (spaces.length > 1) return forkRefused;
  const space = spaces[0]!;
  if (!canSeeSpace(space, access)) return spaceNotFound();
  if (input.requestedSpaceId !== undefined && input.requestedSpaceId !== space.spaceId) return forkRefused;
  return { spaceId: space.spaceId };
}

export async function updateChannel(
  projectId: string,
  viewer: SpaceViewer,
  spaceId: string,
  input: SpaceUpdateInput,
): Promise<SpaceResult> {
  const { userId } = viewer;
  const [row] = await db
    .select()
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.spaceId, spaceId)))
    .limit(1);
  // Another member's DM is not found, never "not editable". So is a private
  // channel the caller may not see, except for a manager: they archive and
  // rename it without reading it.
  if (!row || (row.kind === 'dm' && row.dmUserId !== userId)) return spaceNotFound();
  const hidden = !canSeeSpace(row, viewer.access);
  if (hidden && !viewer.manager) return spaceNotFound();
  if (hidden && (input.description !== undefined || input.agents !== undefined || input.visibility !== undefined)) {
    return {
      error: {
        status: 403,
        body: { error: 'A project manager outside a private channel can only rename or archive it.', code: 'forbidden' },
      },
    };
  }
  if (row.kind !== 'channel') {
    return { error: { status: 400, body: { error: 'A direct message cannot be edited.', code: 'dm_not_editable' } } };
  }
  if (!canEditSpace(row, viewer)) {
    return {
      error: { status: 403, body: { error: 'Only the channel’s creator or a project manager can edit it.', code: 'forbidden' } },
    };
  }
  if (input.archived === true && row.isDefault) {
    return {
      error: { status: 400, body: { error: 'The default channel cannot be archived.', code: 'default_channel' } },
    };
  }
  if (input.visibility === 'private' && row.isDefault) {
    return {
      error: { status: 400, body: { error: 'The default channel is always public.', code: 'default_channel' } },
    };
  }
  const patch: Partial<typeof projectSpaces.$inferInsert> = {};
  if (input.name !== undefined) {
    const slug = spaceSlug(input.name);
    if (!slug) return invalidName();
    patch.name = input.name;
    patch.slug = slug;
  }
  if (input.description !== undefined) patch.description = input.description || null;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? (row.archivedAt ?? new Date()) : null;
  // The route checked every name against the project's agents.
  if (input.agents !== undefined) patch.agents = input.agents;
  const converting = input.visibility === 'private' && row.visibility !== 'private';
  if (converting) patch.visibility = 'private';
  if (Object.keys(patch).length === 0) return { space: row };
  // The folder leaves `/Company` before the switch commits, under the slug it
  // has now (a rename in the same PATCH moves it after, as any rename does).
  // A storage failure refuses the conversion; nothing changed.
  let folderMoved = false;
  if (converting && row.slug) {
    try {
      folderMoved = await (await spaceFolders()).moveChannelFolderVisibility(projectId, { spaceId, slug: row.slug }, 'private');
    } catch (error) {
      logger.warn(`[spaces] the folder of channel ${spaceId} did not move for its conversion to private`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        error: {
          status: 503,
          body: { error: 'The channel’s files could not be moved. It is still public. Try again in a minute.', code: 'folder_move_failed' },
        },
      };
    }
  }
  const moveBack = async () => {
    if (!folderMoved) return;
    await (await spaceFolders()).moveChannelFolderVisibility(projectId, { spaceId, slug: row.slug! }, 'public').catch((error) =>
      logger.error(`[spaces] the folder of channel ${spaceId} is in /Channels but the channel stayed public`, {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  // Conversion adds people only: current project members, never a service
  // account or someone who left.
  const roster = converting ? (await loadProjectRosterIds({ row: { accountId: row.accountId, projectId } })).ids : [];
  try {
    const updated = await db.transaction(async (tx) => {
      const [next] = await tx
        .update(projectSpaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.spaceId, spaceId)))
        .returning();
      // public -> private: nobody loses their own work. The
      // creator and everyone who started a thread in it or added a link become
      // members, in the same transaction as the switch.
      if (converting) await tx.execute(convertMembersSql(spaceId, userId, roster));
      return next;
    });
    const space = updated ?? row;
    if (converting) {
      bustSpaceAccess(projectId);
      // The conversion is committed: a failed audit write is logged, never a 500.
      await recordAuditEvent({
        accountId: row.accountId,
        projectId,
        actorUserId: userId,
        action: 'space.visibility.changed',
        resourceType: 'project_space',
        resourceId: spaceId,
        metadata: { from: row.visibility, to: 'private' },
      }).catch((error: unknown) => {
        logger.warn('[spaces] conversion audit write failed', { spaceId, error: error instanceof Error ? error.message : String(error) });
      });
    }
    const changes = converting ? { converted: true as const } : {};
    return row.slug && space.slug !== row.slug ? { space, renamedFrom: row.slug, ...changes } : { space, ...changes };
  } catch (error) {
    await moveBack();
    if (uniqueViolationConstraint(error) !== SLUG_INDEX) throw error;
    return slugTaken(projectId, patch.slug!, viewer);
  }
}

/**
 * The person converting (a creator or a manager, so they never lock themself
 * out), plus the creator, every thread starter and every link adder of a
 * channel who is in `roster`, inserted as members.
 */
function convertMembersSql(spaceId: string, actorId: string, roster: readonly string[]): SQL {
  const inRoster = roster.length > 0 ? sql.join(roster.map((id) => sql`${id}`), sql`, `) : sql`null`;
  return sql`
    insert into ${projectSpaceMembers} (space_id, user_id, added_by)
    select ${spaceId}::uuid, people.user_id, ${actorId}::uuid
      from (
        select created_by as user_id from ${projectSpaces} where space_id = ${spaceId}::uuid and created_by is not null
        union select created_by from ${projectSessions} where space_id = ${spaceId}::uuid and created_by is not null
        union select created_by from ${projectSpaceLinks} where space_id = ${spaceId}::uuid and created_by is not null
      ) people
     where people.user_id::text in (${inRoster})
    union select ${spaceId}::uuid, ${actorId}::uuid, ${actorId}::uuid
    on conflict do nothing`;
}

/**
 * The caller's DM with `agentName`, created on first call. The route checks
 * that the agent exists and that the caller may run it.
 */
export async function getOrCreateDm(
  projectId: string,
  accountId: string,
  userId: string,
  agentName: string,
): Promise<SpaceRow> {
  const [row] = await db
    .insert(projectSpaces)
    .values({ accountId, projectId, kind: 'dm', name: agentName, dmUserId: userId, dmAgentName: agentName, createdBy: userId })
    .onConflictDoUpdate({
      target: [projectSpaces.projectId, projectSpaces.dmUserId, projectSpaces.dmAgentName],
      targetWhere: sql`${projectSpaces.kind} = 'dm'`,
      // A no-op write so RETURNING yields the existing row.
      set: { dmAgentName: sql`excluded.dm_agent_name` },
    })
    .returning();
  return row!;
}

/**
 * File every session that has no space into `defaultSpaceId`, 1,000 rows per
 * statement so no statement holds row locks for long, until a statement files
 * none (a short batch can come from a concurrent writer). Returns the row count.
 */
export async function assignUnassignedSessions(projectId: string, defaultSpaceId: string): Promise<number> {
  const unassigned = and(eq(projectSessions.projectId, projectId), isNull(projectSessions.spaceId));
  let total = 0;
  for (;;) {
    const batch = db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(unassigned)
      .limit(ASSIGN_BATCH);
    const updated = await db
      .update(projectSessions)
      .set({ spaceId: defaultSpaceId })
      // `unassigned` again on the outer row: a session filed concurrently keeps its space.
      .where(and(unassigned, inArray(projectSessions.sessionId, batch)))
      .returning({ sessionId: projectSessions.sessionId });
    if (updated.length === 0) return total;
    total += updated.length;
  }
}
