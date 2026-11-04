/**
 * The channel or DM a trigger posts its runs to (`project_trigger_runtime.space_id`,
 * flag `project_channels`). Account-local like the trigger's access policy, so it
 * is not in the repo manifest. The routes validate it on write
 * (`resolveTriggerSpace`); session create reads it for every run of the trigger
 * (`liveTriggerSpace`), so a queued run resolves the space when it executes.
 */
import type { TriggerSessionAccess } from '@kortix/api-contract';
import { projectSpaces, projectTriggerRuntime } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import {
  PRIVATE_TRIGGER_SESSION_ACCESS,
  parseTriggerSessionAccess,
  validateTriggerSessionAccessPrincipals,
} from '../trigger-session-access';
import { SPACE_NOT_FOUND } from './project-spaces';
import { canSeeSpace, spaceAccessFor } from '../../shared/space-access';

type SpaceRow = typeof projectSpaces.$inferSelect;

export type TriggerSpaceError = {
  status: 400 | 403 | 404;
  body: { error: string; code?: string };
};

/** The caller of a trigger write: `loadProjectForUser`'s result, and `callerKortixSessionId` as `bound`. */
type TriggerCaller = { userId: string; bound: string | null; row: { accountId: string; metadata: unknown } };

/** A channel trigger with no explicit policy: its threads are project-visible, like any channel thread. */
export const PROJECT_TRIGGER_SESSION_ACCESS: TriggerSessionAccess = { mode: 'project', memberIds: [], groupIds: [] };

/**
 * A DM trigger's policy, whatever the caller asked for. Its runs are attributed
 * to the agent's service account, so `private` would hide them from the DM's
 * own member: the thread is shared with that one member instead.
 */
function dmTriggerSessionAccess(space: SpaceRow): TriggerSessionAccess {
  return { mode: 'members', memberIds: [space.dmUserId!], groupIds: [] };
}

/**
 * The space a caller may point a trigger at: a live channel of the project the
 * caller may see, or the caller's own live DM. An unknown, archived or foreign
 * id and a private channel the caller is not in are 404; another member's DM
 * is 403.
 */
export async function resolveTriggerSpace(
  projectId: string,
  spaceId: unknown,
  caller: Pick<TriggerCaller, 'userId' | 'bound'>,
): Promise<{ space: SpaceRow } | { error: TriggerSpaceError }> {
  const { userId } = caller;
  if (typeof spaceId !== 'string') {
    return { error: { status: 400, body: { error: 'space_id must be a channel or DM id, or null', code: 'invalid_space_id' } } };
  }
  const [row] = isUuid(spaceId)
    ? await db
        .select()
        .from(projectSpaces)
        .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.spaceId, spaceId), isNull(projectSpaces.archivedAt)))
        .limit(1)
    : [];
  if (!row || !canSeeSpace(row, await spaceAccessFor(projectId, userId, caller.bound))) {
    return { error: { status: 404, body: SPACE_NOT_FOUND } };
  }
  if (row.kind === 'dm' && row.dmUserId !== userId) {
    return {
      error: { status: 403, body: { error: 'Only the member a DM belongs to can post a trigger to it.', code: 'space_forbidden' } },
    };
  }
  return { space: row };
}

const isPrivateChannel = (space: SpaceRow) => space.kind === 'channel' && space.visibility === 'private';

/**
 * 400 `private_channel_trigger`: a trigger lives in the project config, which
 * people outside a private channel may edit, so it never posts into one
 * (`PRIVATE_CHANNEL_TRIGGER` in trigger-fire.ts refuses its runs too).
 */
function privateChannelTrigger(): { error: TriggerSpaceError } {
  return {
    error: {
      status: 400,
      body: {
        error: 'A trigger cannot post into a private channel: the project config it lives in is editable by people outside the channel.',
        code: 'private_channel_trigger',
      },
    },
  };
}

/** The space stored on a trigger, archived or not; null when it has none. */
export async function loadTriggerSpace(projectId: string, slug: string): Promise<SpaceRow | null> {
  const [row] = await db
    .select({ space: projectSpaces })
    .from(projectTriggerRuntime)
    .innerJoin(projectSpaces, eq(projectSpaces.spaceId, projectTriggerRuntime.spaceId))
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)))
    .limit(1);
  return row?.space ?? null;
}

/**
 * A PATCH's space and sharing, from the stored space, the space the body asks
 * for (undefined: none named) and the sharing it saves (null: none). Naming the
 * stored space is no move. A move applies to later runs only; into a channel
 * with no sharing saved, they become project-visible. A DM trigger's runs stay
 * shared with the DM's member only. Only a sharing save outside a DM with no
 * move re-shares earlier threads (`propagate`).
 */
export function decideTriggerSpacePatch(
  stored: SpaceRow | null,
  requested: SpaceRow | null | undefined,
  access: TriggerSessionAccess | null,
): { nextSpace: SpaceRow | null | undefined; space: SpaceRow | null; access: TriggerSessionAccess | null; propagate: boolean } {
  const nextSpace = requested !== undefined && (requested?.spaceId ?? null) !== (stored?.spaceId ?? null) ? requested : undefined;
  const space = nextSpace !== undefined ? nextSpace : stored;
  const propagate = access !== null && nextSpace === undefined && space?.kind !== 'dm';
  if (space?.kind === 'dm' && (access || nextSpace !== undefined)) access = dmTriggerSessionAccess(space);
  else if (nextSpace?.kind === 'channel' && !access) access = PROJECT_TRIGGER_SESSION_ACCESS;
  return { nextSpace, space, access, propagate };
}

/**
 * A DM is one member with one agent: a trigger that posts to it runs that
 * agent, as a DM thread does (`project-sessions.ts` forces `agent_name`).
 */
export function dmAgentMismatch(
  space: { kind: 'channel' | 'dm'; dmAgentName: string | null } | null,
  agent: string,
): { error: string; code: 'agent_mismatch' } | null {
  if (space?.kind !== 'dm' || !space.dmAgentName || agent === space.dmAgentName) return null;
  return {
    error: `A trigger that posts to a DM runs the DM's agent. Set agent to "${space.dmAgentName}".`,
    code: 'agent_mismatch',
  };
}

/** Check a sharing's members and groups belong to the account (400 when not). */
async function checkPrincipals(accountId: string, access: TriggerSessionAccess): Promise<{ error: TriggerSpaceError } | null> {
  const invalid = await validateTriggerSessionAccessPrincipals(accountId, access);
  return invalid ? { error: { status: 400, body: { error: invalid } } } : null;
}

/**
 * A create's sharing when the body names none: a DM's member only (always, see
 * `dmTriggerSessionAccess`), project-visible in a channel, private without a space.
 * Undefined: the body's own `session_access` decides.
 */
export function defaultTriggerCreateAccess(space: SpaceRow | null, sessionAccess: unknown): TriggerSessionAccess | undefined {
  if (space?.kind === 'dm') return dmTriggerSessionAccess(space);
  if (sessionAccess !== undefined) return undefined;
  return space ? PROJECT_TRIGGER_SESSION_ACCESS : PRIVATE_TRIGGER_SESSION_ACCESS;
}

/**
 * A create body's space and sharing. `project_channels` off: `space_id` is
 * ignored, never stored. A DM trigger must run the DM's agent (400).
 */
export async function resolveTriggerSpaceCreate(
  projectId: string,
  caller: TriggerCaller,
  body: Record<string, unknown>,
  agent: string,
): Promise<{ space: SpaceRow | null; access: TriggerSessionAccess } | { error: TriggerSpaceError }> {
  let space: SpaceRow | null = null;
  if (resolveFeatureFlag(caller.row.metadata, 'project_channels') && body.space_id != null) {
    const found = await resolveTriggerSpace(projectId, body.space_id, caller);
    if ('error' in found) return found;
    if (isPrivateChannel(found.space)) return privateChannelTrigger();
    space = found.space;
  }
  const mismatch = dmAgentMismatch(space, agent);
  if (mismatch) return { error: { status: 400, body: mismatch } };
  let access = defaultTriggerCreateAccess(space, body.session_access);
  if (!access) {
    const parsed = parseTriggerSessionAccess(body.session_access);
    if (!parsed.ok) return { error: { status: 400, body: { error: parsed.error } } };
    access = parsed.access;
  }
  return (await checkPrincipals(caller.row.accountId, access)) ?? { space, access };
}

/**
 * `decideTriggerSpacePatch` for a PATCH body, with its `session_access` parsed
 * and checked. `project_channels` off: `space_id` is ignored. The stored space
 * is read whatever the flag, so a flag-off sharing write on a DM trigger stays
 * DM-only. Another member's DM trigger: anyone else may only move it out or
 * switch it on or off (403). `agentSpace` is the space whose DM agent the PATCH
 * must run: set only when it sets the agent or moves the trigger, so a manifest
 * edit that changed the agent never blocks switching the trigger off (its runs
 * go to the default channel).
 */
export async function resolveTriggerSpacePatch(
  projectId: string,
  slug: string,
  caller: TriggerCaller,
  body: Record<string, unknown>,
): Promise<(ReturnType<typeof decideTriggerSpacePatch> & { agentSpace: SpaceRow | null }) | { error: TriggerSpaceError }> {
  const { userId } = caller;
  const parsed = body.session_access === undefined ? null : parseTriggerSessionAccess(body.session_access);
  if (parsed && !parsed.ok) return { error: { status: 400, body: { error: parsed.error } } };
  let requested: SpaceRow | null | undefined;
  if (resolveFeatureFlag(caller.row.metadata, 'project_channels') && 'space_id' in body) {
    if (body.space_id === null) requested = null;
    else {
      const found = await resolveTriggerSpace(projectId, body.space_id, caller);
      if ('error' in found) return found;
      if (isPrivateChannel(found.space)) return privateChannelTrigger();
      requested = found.space;
    }
  }
  const stored = await loadTriggerSpace(projectId, slug);
  const onlyMovesOrToggles = !Object.keys(body).some((key) => key !== 'space_id' && key !== 'enabled');
  if (stored?.kind === 'dm' && stored.dmUserId !== userId && !onlyMovesOrToggles) {
    return {
      error: { status: 403, body: { error: 'Only the member a DM belongs to can edit a trigger that posts to it.', code: 'space_forbidden' } },
    };
  }
  // A trigger posting to a private channel the caller is not in: they may only move it out or switch it.
  if (stored && !onlyMovesOrToggles && !canSeeSpace(stored, await spaceAccessFor(projectId, userId, caller.bound))) {
    return {
      error: { status: 403, body: { error: 'Only the channel’s members can edit a trigger that posts to it.', code: 'space_forbidden' } },
    };
  }
  const decision = decideTriggerSpacePatch(stored, requested, parsed?.ok ? parsed.access : null);
  const invalid = decision.access ? await checkPrincipals(caller.row.accountId, decision.access) : null;
  if (invalid) return invalid;
  const checksAgent = decision.nextSpace !== undefined || 'agent' in body;
  return { ...decision, agentSpace: checksAgent ? decision.space : null };
}

/**
 * The space a run lands in: its trigger's live space, except a DM whose agent
 * the trigger no longer runs (the manifest changed outside the API). That run,
 * like one with no live space, goes to the default channel (null) with the
 * trigger's own sharing.
 */
export function triggerRunSpace(space: SpaceRow | null, agentName: string | null | undefined): SpaceRow | null {
  if (space?.kind === 'dm' && agentName !== space.dmAgentName) return null;
  return space;
}

/** The space a run of this trigger lands in now: null when it has none or the space is archived. */
export async function liveTriggerSpace(projectId: string, slug: string): Promise<SpaceRow | null> {
  const space = await loadTriggerSpace(projectId, slug);
  return space && !space.archivedAt ? space : null;
}

export async function setTriggerSpace(projectId: string, slug: string, spaceId: string | null): Promise<void> {
  await db
    .update(projectTriggerRuntime)
    .set({ spaceId, updatedAt: new Date() })
    .where(and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)));
}

