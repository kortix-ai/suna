/**
 * Project spaces: channels (product word "Channel") and a member's DMs with one
 * agent, one table `kortix.project_spaces`. A thread is a `project_sessions` row
 * whose `space_id` points here. Behind the `project_channels` flag; the routes
 * live in `routes/project-spaces.ts`.
 *
 * Only `ensureDefaultSpace` ever sets `is_default`. Channel slugs are unique per
 * project INCLUDING archived channels, so a clash with an archived channel
 * answers 409 with `archived: true` and the client offers to unarchive it.
 */
import type { Space, SpaceCreateInput, SpaceUpdateInput } from '@kortix/api-contract';
import { projectSessions, projectSpaces } from '@kortix/db';
import { spaceSlug } from '@kortix/shared';
import { type SQL, and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import { uniqueViolationConstraint } from '../../shared/postgres-errors';
import { normalizeString } from './serializers';

type SpaceRow = typeof projectSpaces.$inferSelect;

export type SpaceError = {
  status: 400 | 404 | 409;
  body: { error: string; code: string; space_id?: string; archived?: boolean };
};
/** `renamedFrom`: the slug a rename replaced. */
export type SpaceResult = { space: SpaceRow; renamedFrom?: string } | { error: SpaceError };

const DEFAULT_SLUG = 'general';
const SLUG_INDEX = 'uniq_project_spaces_channel_slug';
const ASSIGN_BATCH = 1_000;
/** `metadata.first_prompt`: what a channel timeline shows as the thread's top message. */
export const FIRST_PROMPT_MAX_CHARS = 500;

export function serializeSpace(row: SpaceRow): Space {
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
 */
export async function ensureDefaultSpace(projectId: string, accountId: string): Promise<SpaceRow> {
  const general = await ensureDefaultSpaceCreated(projectId, accountId);
  if (general.created) await assignUnassignedSessions(projectId, general.space.spaceId);
  return general.space;
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

/** Live channels (default first, then oldest first), then the user's DMs. */
export async function listSpacesForUser(projectId: string, accountId: string, userId: string): Promise<SpaceRow[]> {
  await ensureDefaultSpace(projectId, accountId);
  return db
    .select()
    .from(projectSpaces)
    .where(
      and(
        eq(projectSpaces.projectId, projectId),
        isNull(projectSpaces.archivedAt),
        or(eq(projectSpaces.kind, 'channel'), eq(projectSpaces.dmUserId, userId)),
      ),
    )
    .orderBy(asc(projectSpaces.kind), desc(projectSpaces.isDefault), asc(projectSpaces.createdAt), asc(projectSpaces.spaceId));
}

function invalidName(): { error: SpaceError } {
  return {
    error: { status: 400, body: { error: 'The name needs at least one letter or digit.', code: 'invalid_name' } },
  };
}

/** 409 naming the channel that holds `slug`, and whether it is archived. */
async function slugTaken(projectId: string, slug: string): Promise<{ error: SpaceError }> {
  const [holder] = await db
    .select({ spaceId: projectSpaces.spaceId, archivedAt: projectSpaces.archivedAt })
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'channel'), eq(projectSpaces.slug, slug)))
    .limit(1);
  const archived = Boolean(holder?.archivedAt);
  return {
    error: {
      status: 409,
      body: {
        error: archived ? `An archived channel is already named #${slug}.` : `A channel is already named #${slug}.`,
        code: 'slug_taken',
        ...(holder ? { space_id: holder.spaceId } : {}),
        archived,
      },
    },
  };
}

export async function createChannel(
  projectId: string,
  accountId: string,
  userId: string,
  input: SpaceCreateInput,
): Promise<SpaceResult> {
  const slug = spaceSlug(input.name);
  if (!slug) return invalidName();
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
        createdBy: userId,
      })
      .returning();
    return { space: row! };
  } catch (error) {
    if (uniqueViolationConstraint(error) !== SLUG_INDEX) throw error;
    return slugTaken(projectId, slug);
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
export async function findSessionSpace(projectId: string, spaceId: string, userId: string): Promise<SpaceRow | null> {
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
  return row ?? null;
}

/** A live channel of the project; a DM, an archived or a foreign channel is null. Every member sees every channel. */
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

/** A fork source's space, when the caller may file a session into it, and the source's sharing. */
export async function findForkSourceSpace(
  projectId: string,
  sourceSessionId: string,
  userId: string,
): Promise<{ space: SpaceRow; visibility: SessionVisibility } | null> {
  const [source] = await db
    .select({ spaceId: projectSessions.spaceId, visibility: projectSessions.visibility })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sourceSessionId)))
    .limit(1);
  const space = source?.spaceId ? await findSessionSpace(projectId, source.spaceId, userId) : null;
  return space ? { space, visibility: source!.visibility as SessionVisibility } : null;
}

export async function updateChannel(
  projectId: string,
  userId: string,
  spaceId: string,
  input: SpaceUpdateInput,
): Promise<SpaceResult> {
  const [row] = await db
    .select()
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.spaceId, spaceId)))
    .limit(1);
  // Another member's DM is not found, never "not editable".
  if (!row || (row.kind === 'dm' && row.dmUserId !== userId)) return spaceNotFound();
  if (row.kind !== 'channel') {
    return { error: { status: 400, body: { error: 'A direct message cannot be edited.', code: 'dm_not_editable' } } };
  }
  if (input.archived === true && row.isDefault) {
    return {
      error: { status: 400, body: { error: 'The default channel cannot be archived.', code: 'default_channel' } },
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
  if (Object.keys(patch).length === 0) return { space: row };
  try {
    const [updated] = await db
      .update(projectSpaces)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.spaceId, spaceId)))
      .returning();
    const space = updated ?? row;
    return row.slug && space.slug !== row.slug ? { space, renamedFrom: row.slug } : { space };
  } catch (error) {
    if (uniqueViolationConstraint(error) !== SLUG_INDEX) throw error;
    return slugTaken(projectId, patch.slug!);
  }
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
