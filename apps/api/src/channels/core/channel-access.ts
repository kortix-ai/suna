/**
 * Channel access: who may talk to a chat platform's bot. The lists live in
 * `projects.metadata.<platform>`:
 * - `allowedUserIds`: the project's allowed senders, in list order. They stay
 *   across a reconnect.
 * - `accessRequests`: people who messaged the bot privately and are not
 *   allowed, newest first: at most 20, under 30 days old. Only the id and the
 *   names are kept, never a message. They belong to one install (the scope,
 *   `chat_installs.workspace_id`): a disconnect or another install's connect
 *   clears them.
 *
 * Add a platform: name it in CHANNEL_ACCESS_PLATFORMS
 * (shared/channel-access-platforms.ts), which also hides its key from project
 * reads, record requests with its `chat_installs.workspace_id` as the scope,
 * give it a ChannelAccessPort for names, photos and the routes
 * (telegram/access.ts is the reference), register its 5 access routes with
 * registerChannelAccessRoutes (projects/routes/channel-access.ts), each with
 * its line in packages/shared/src/audit-route-labels.ts, and gate its
 * messages with gateSender and its button presses with refusedPressText.
 */
import { chatInstalls, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { metadataClearSubtreeKey, metadataMergeSubtree } from '../../projects/surface';
import type { ChannelAccessPlatform } from '../../shared/channel-access-platforms';
import { databaseErrorSummary } from '../../shared/database-errors';
import { db } from '../../shared/db';

export const CHANNEL_MAX_ALLOWED_USERS = 200;
const MAX_ACCESS_REQUESTS = 20;
const ACCESS_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A repeat message within this long, under the same names, writes nothing. */
const ACCESS_REQUEST_THROTTLE_MS = 60 * 60 * 1000;

/** Who asked for access: only these fields of the sender, never the message. */
export interface ChannelAccessEntry {
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  last_seen: string;
}

export type ChannelAccessRequester = Omit<ChannelAccessEntry, 'last_seen'>;

export interface ChannelAccessLists {
  allowedUserIds: string[];
  /** Requests still waiting: not allowed, under 30 days old. */
  accessRequests: ChannelAccessEntry[];
}

/** The photo types the core serves; it checks a photo's magic bytes against the port's list. */
export type ChannelPhotoType = 'image/jpeg' | 'image/png' | 'image/webp';

/** A user's names and photo as the platform answers them. */
export interface ChannelAccessProfile {
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  /** `ref` fetches the photo; `version` changes when the photo changes. Null: no photo. */
  photo: { ref: string; version: string } | null;
}

/** What a platform supplies to the channel access core. */
export interface ChannelAccessPort {
  /** The metadata key, `chat_installs.platform`, the route path segment and the error code prefix. */
  platform: ChannelAccessPlatform;
  /** The platform's name in error messages and route docs: 'Telegram'. */
  label: string;
  /** A valid user id. */
  userId: RegExp;
  /** What a valid user id is, after "must be a": 'numeric Telegram user id'. */
  idDescription: string;
  photoTypes: readonly ChannelPhotoType[];
  /** The install's scope, the credential for the platform's API, and the lists. Null: not connected. */
  connection(projectId: string): Promise<{ scopeId: string; credential: string | null; lists: ChannelAccessLists } | null>;
  /** The body the access edit routes answer. Null: not connected. */
  installation(projectId: string): Promise<object | null>;
  /** The sender's id and cleaned names from the platform's sender object. Null: no valid user id. */
  requester(from: unknown): ChannelAccessRequester | null;
  /** Null: the platform gives no profile. Throws only when the platform is unreachable. */
  fetchProfile(credential: string, userId: string): Promise<ChannelAccessProfile | null>;
  /** At most `maxBytes`. Null: no photo. Throws only when the platform is unreachable. */
  fetchPhoto(credential: string, ref: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null>;
}

const stored = (metadata: unknown, platform: ChannelAccessPlatform) =>
  (metadata as Partial<Record<string, { allowedUserIds?: unknown; accessRequests?: unknown }>> | null)?.[platform];

/** A legacy entry may be a number: read as a string. */
function allowedIds(metadata: unknown, platform: ChannelAccessPlatform): string[] {
  const ids = stored(metadata, platform)?.allowedUserIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

/** Every stored request, as written; a malformed entry is skipped. */
function storedRequests(metadata: unknown, platform: ChannelAccessPlatform): ChannelAccessEntry[] {
  const list = stored(metadata, platform)?.accessRequests;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r): r is ChannelAccessEntry =>
      typeof r?.id === 'string' && typeof r.last_seen === 'string' && !Number.isNaN(Date.parse(r.last_seen)),
  );
}

/** The requests still waiting: not allowed, and under 30 days old. */
function waitingRequests(requests: ChannelAccessEntry[], allowedUserIds: string[]): ChannelAccessEntry[] {
  const now = Date.now();
  return requests.filter((r) => !allowedUserIds.includes(r.id) && now - Date.parse(r.last_seen) < ACCESS_REQUEST_TTL_MS);
}

/** The platform's lists in a project's metadata, waiting requests newest first. */
export function readChannelAccess(metadata: unknown, platform: ChannelAccessPlatform): ChannelAccessLists {
  const allowedUserIds = allowedIds(metadata, platform);
  return {
    allowedUserIds,
    accessRequests: waitingRequests(storedRequests(metadata, platform), allowedUserIds).sort(
      (a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen),
    ),
  };
}

/**
 * Edit the allowed list and the requests under the project row's lock, so
 * concurrent edits (an admin's Allow, a new request) all land. `edit` gets the
 * waiting requests and returns the lists to write, or null for no change.
 * Every write drops expired requests and the requests of allowed ids, so a
 * removed user's old request never comes back. With `scopeId`, nothing is
 * edited unless the project still has that install of `platform`.
 */
async function editChannelAccess(
  platform: ChannelAccessPlatform,
  projectId: string,
  edit: (lists: ChannelAccessLists) => Partial<ChannelAccessLists> | null,
  scopeId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .for('update');
    if (!row) return;
    if (scopeId) {
      // A disconnect or another install's connect clears the requests after this check, or waits for this lock.
      const [install] = await tx
        .select({ scopeId: chatInstalls.workspaceId })
        .from(chatInstalls)
        .where(and(eq(chatInstalls.platform, platform), eq(chatInstalls.projectId, projectId), eq(chatInstalls.workspaceId, scopeId)))
        .limit(1);
      if (!install) return;
    }
    const requests = storedRequests(row.metadata, platform);
    const allowedUserIds = allowedIds(row.metadata, platform);
    const waiting = waitingRequests(requests, allowedUserIds);
    const patch = edit({ allowedUserIds, accessRequests: waiting });
    const accessRequests = waitingRequests(patch?.accessRequests ?? waiting, patch?.allowedUserIds ?? allowedUserIds);
    if (patch || accessRequests.length !== requests.length) {
      await tx
        .update(projects)
        .set({ metadata: metadataMergeSubtree(platform, { ...patch, accessRequests }) })
        .where(eq(projects.projectId, projectId));
    }
  });
}

/** Replace the allowed list; the write drops the requests of the ids it allows. */
export async function setChannelAllowedUsers(platform: ChannelAccessPlatform, projectId: string, ids: string[]): Promise<void> {
  await editChannelAccess(platform, projectId, () => ({ allowedUserIds: ids }));
}

/** Allow one user; the write drops their request. False: the list is full. */
export async function allowChannelUser(platform: ChannelAccessPlatform, projectId: string, id: string): Promise<boolean> {
  let full = false;
  await editChannelAccess(platform, projectId, ({ allowedUserIds }) => {
    if (allowedUserIds.includes(id)) return null;
    if (allowedUserIds.length >= CHANNEL_MAX_ALLOWED_USERS) {
      full = true;
      return null;
    }
    return { allowedUserIds: [...allowedUserIds, id] };
  });
  return !full;
}

export async function removeChannelUser(platform: ChannelAccessPlatform, projectId: string, id: string): Promise<void> {
  await editChannelAccess(platform, projectId, ({ allowedUserIds }) =>
    allowedUserIds.includes(id) ? { allowedUserIds: allowedUserIds.filter((u) => u !== id) } : null,
  );
}

export async function dismissChannelAccessRequest(platform: ChannelAccessPlatform, projectId: string, id: string): Promise<void> {
  await editChannelAccess(platform, projectId, ({ accessRequests }) =>
    accessRequests.some((r) => r.id === id) ? { accessRequests: accessRequests.filter((r) => r.id !== id) } : null,
  );
}

/** Drop every request; the allowed list stays. */
export async function clearChannelAccessRequests(platform: ChannelAccessPlatform, projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({ metadata: metadataClearSubtreeKey(platform, 'accessRequests') })
    .where(eq(projects.projectId, projectId));
}

/**
 * A sender's name: a string without control or format characters (bidi
 * overrides and isolates, zero-width), at most `max` code points (never half an emoji).
 */
export function cleanName(value: unknown, max: number): string | null {
  return typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, '')).slice(0, max).join('') || null : null;
}

/**
 * Record that a not-allowed user messaged the bot privately. The newest 20
 * requests under 30 days old stay. A repeat within an hour under the same
 * names writes nothing, and takes no lock when the loaded `scope` already
 * shows it. Nothing is written once the `scopeId` install is gone. True: the
 * request is stored. False: it is not (the user is allowed, or the install is gone).
 */
export async function recordChannelAccessRequest(
  platform: ChannelAccessPlatform,
  projectId: string,
  scope: { scopeId: string; accessRequests: ChannelAccessEntry[] },
  requester: ChannelAccessRequester,
): Promise<boolean> {
  const { id } = requester;
  const now = Date.now();
  const entry: ChannelAccessEntry = {
    id,
    username: requester.username,
    first_name: requester.first_name,
    last_name: requester.last_name,
    last_seen: new Date(now).toISOString(),
  };
  const current = (requests: ChannelAccessEntry[]) => {
    const previous = requests.find((r) => r.id === id);
    return (
      !!previous &&
      now - Date.parse(previous.last_seen) < ACCESS_REQUEST_THROTTLE_MS &&
      previous.username === entry.username &&
      previous.first_name === entry.first_name &&
      previous.last_name === entry.last_name
    );
  };
  // Most repeats end here, without the row lock.
  if (current(scope.accessRequests)) return true;
  let recorded = false;
  await editChannelAccess(
    platform,
    projectId,
    ({ allowedUserIds, accessRequests }) => {
      if (allowedUserIds.includes(id)) return null;
      recorded = true;
      if (current(accessRequests)) return null;
      return { accessRequests: [entry, ...accessRequests.filter((r) => r.id !== id)].slice(0, MAX_ACCESS_REQUESTS) };
    },
    scope.scopeId,
  );
  return recorded;
}

/**
 * The gate for a message: null when the sender is allowed, otherwise the
 * pairing reply. In a direct chat, a sender with a valid id is also recorded
 * as an access request; a failed write still gets the plain reply.
 */
export async function gateSender(
  port: ChannelAccessPort,
  input: { projectId: string; scopeId: string; lists: ChannelAccessLists; senderId: string; direct: boolean; from: unknown },
): Promise<string | null> {
  const { projectId, senderId } = input;
  if (senderId && input.lists.allowedUserIds.includes(senderId)) return null;
  // Only a direct chat asks for access: there the sender wrote to the bot itself.
  const asks = !!senderId && input.direct;
  const requester = asks ? port.requester(input.from) : null;
  const waiting =
    !!requester &&
    (await recordChannelAccessRequest(
      port.platform,
      projectId,
      { scopeId: input.scopeId, accessRequests: input.lists.accessRequests },
      requester,
    ).catch((error) => {
      // A failed query's message carries its parameters, the sender's names among them.
      logger.warn(`[${port.platform}] access request not recorded`, {
        projectId,
        error: databaseErrorSummary(error) ?? String(error),
      });
      return false;
    }));
  const { label } = port;
  return (
    `This bot belongs to a Kortix project, and your ${label} account is not allowed to use it yet. ` +
    (waiting
      ? `Your request is waiting for a project admin, who can allow it in Kortix under Customize → Connectors → Channels → ${label}. Your ${label} user ID is ${senderId}.`
      : `Ask a project admin to allow your ${label} user ID ${senderId || '(unknown)'} under Customize → Connectors → Channels → ${label}${asks ? '' : ', or message this bot privately to ask for access'}.`)
  );
}

/** The alert for a button press from a sender who is not allowed. Only they see it: never post it to the chat. */
export function refusedPressText(port: ChannelAccessPort, senderId: string): string {
  return `Your ${port.label} account is not allowed to use this bot. Ask a project admin to allow user ID ${senderId} under Customize → Connectors → Channels → ${port.label}.`;
}
