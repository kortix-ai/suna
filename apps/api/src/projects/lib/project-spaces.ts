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
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { uniqueViolationConstraint } from '../../shared/postgres-errors';

type SpaceRow = typeof projectSpaces.$inferSelect;

export type SpaceError = {
  status: 400 | 404 | 409;
  body: { error: string; code: string; space_id?: string; archived?: boolean };
};
export type SpaceResult = { space: SpaceRow } | { error: SpaceError };

const DEFAULT_SLUG = 'general';
const SLUG_MAX = 40;
const SLUG_INDEX = 'uniq_project_spaces_channel_slug';
const ASSIGN_BATCH = 1_000;

/** Lowercase, spaces → `-`, other characters dropped, `-` trimmed, at most 40 chars. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '');
}

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

/** The project's `#general`, created on first call. Idempotent under concurrency. */
export async function ensureDefaultSpace(projectId: string, accountId: string): Promise<SpaceRow> {
  const existing = await findDefaultSpace(projectId);
  if (existing) return existing;
  const [inserted] = await db
    .insert(projectSpaces)
    .values({ accountId, projectId, kind: 'channel', slug: DEFAULT_SLUG, name: DEFAULT_SLUG, isDefault: true })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const raced = await findDefaultSpace(projectId);
  if (!raced) throw new Error(`project ${projectId} has no default space and '${DEFAULT_SLUG}' is taken`);
  return raced;
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
  const slug = slugify(input.name);
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

export async function updateChannel(projectId: string, spaceId: string, input: SpaceUpdateInput): Promise<SpaceResult> {
  const [row] = await db
    .select()
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.spaceId, spaceId)))
    .limit(1);
  if (!row) return { error: { status: 404, body: { error: 'Channel not found', code: 'space_not_found' } } };
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
    const slug = slugify(input.name);
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
    return { space: updated ?? row };
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
 * statement so no statement holds row locks for long. Returns the row count.
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
    total += updated.length;
    if (updated.length < ASSIGN_BATCH) return total;
  }
}
