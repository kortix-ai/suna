/**
 * Who a platform's allowed users and access requests are: names and the photo
 * version from the platform's profile, and the photo bytes through the API.
 * The credential and the platform's file URLs stay on the server.
 */
import { mapWithConcurrency } from '../../shared/map-with-concurrency';
import type { ChannelAccessEntry, ChannelAccessPort, ChannelAccessProfile, ChannelPhotoType } from './channel-access';

export interface ChannelUser {
  user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  /** Changes when the photo changes; null: no photo. */
  photo_version: string | null;
  /** False: the platform gave no profile and nothing is stored. */
  known: boolean;
}

const PROFILE_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
/** No new profile lookup starts after this long, so a list of 200 stays under the request deadline. */
const LIST_BUDGET_MS = 8_000;
const MAX_PROFILES = 1_000;
const MAX_PHOTO_BYTES = 1024 * 1024;

/** The magic bytes that start each photo type; null matches any byte (the RIFF size). */
const PHOTO_SIGNATURES: Record<ChannelPhotoType, (number | null)[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
};

// replica-local: a profile answers per (platform, scope, user), 10 min for a profile and 60 s for a miss; a cold replica asks the platform again.
const profiles = new Map<string, { expires: number; value: Promise<ChannelAccessProfile | null> }>();

/** The cached profile; `cacheOnly` starts no lookup and answers null on a miss. */
function cachedProfile(
  port: ChannelAccessPort,
  credential: string,
  scopeId: string,
  userId: string,
  cacheOnly = false,
): Promise<ChannelAccessProfile | null> {
  // A photo ref is valid only for the install that read it (Telegram: the bot).
  const key = `${port.platform}:${scopeId}:${userId}`;
  const hit = profiles.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (cacheOnly) return Promise.resolve(null);
  const entry = { expires: Date.now() + MISS_TTL_MS, value: port.fetchProfile(credential, userId) };
  entry.value.then(
    (profile) => {
      if (profile) entry.expires = Date.now() + PROFILE_TTL_MS;
    },
    () => undefined,
  );
  profiles.delete(key);
  profiles.set(key, entry);
  if (profiles.size > MAX_PROFILES) profiles.delete(profiles.keys().next().value!);
  return entry.value;
}

function channelUser(userId: string, profile: ChannelAccessProfile | null, stored?: ChannelAccessEntry): ChannelUser {
  const names = profile ?? stored;
  return {
    user_id: userId,
    username: names?.username ?? null,
    first_name: names?.first_name ?? null,
    last_name: names?.last_name ?? null,
    photo_version: profile?.photo?.version ?? null,
    known: !!names,
  };
}

/**
 * The allowed users in list order and the waiting requests newest first, each
 * with its profile. A failed lookup falls back to the names a request stored,
 * else `known: false`; it never fails the list. Null: not connected.
 */
export async function listChannelUsers(
  port: ChannelAccessPort,
  projectId: string,
): Promise<{ allowed: ChannelUser[]; requests: (ChannelUser & { last_seen: string })[] } | null> {
  const connection = await port.connection(projectId);
  if (!connection) return null;
  const { scopeId, credential, lists } = connection;
  const deadline = Date.now() + LIST_BUDGET_MS;
  const profile = (userId: string) =>
    credential ? cachedProfile(port, credential, scopeId, userId, Date.now() > deadline).catch(() => null) : Promise.resolve(null);
  const allowedCount = lists.allowedUserIds.length;
  const found = await mapWithConcurrency([...lists.allowedUserIds, ...lists.accessRequests.map((r) => r.id)], 5, profile);
  return {
    allowed: lists.allowedUserIds.map((id, i) => channelUser(id, found[i] ?? null)),
    requests: lists.accessRequests.map((r, i) => ({ ...channelUser(r.id, found[allowedCount + i] ?? null, r), last_seen: r.last_seen })),
  };
}

export type ChannelUserPhoto =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; contentType: ChannelPhotoType }
  | { ok: false; code: 'not_connected' | 'user_unknown' | 'photo_unavailable' | 'unreachable' };

/**
 * A listed user's photo. Only an allowed or requesting user: the bot is no
 * lookup service. Only bytes that start like one of `port.photoTypes` are
 * served, and with that type.
 */
export async function channelUserPhoto(port: ChannelAccessPort, projectId: string, userId: string): Promise<ChannelUserPhoto> {
  const connection = await port.connection(projectId);
  if (!connection?.credential) return { ok: false, code: 'not_connected' };
  const { scopeId, credential, lists } = connection;
  if (!lists.allowedUserIds.includes(userId) && !lists.accessRequests.some((r) => r.id === userId)) {
    return { ok: false, code: 'user_unknown' };
  }
  try {
    const photo = (await cachedProfile(port, credential, scopeId, userId))?.photo;
    const bytes = photo ? await port.fetchPhoto(credential, photo.ref, MAX_PHOTO_BYTES) : null;
    const contentType = bytes && port.photoTypes.find((type) => PHOTO_SIGNATURES[type].every((b, i) => b === null || bytes[i] === b));
    if (!bytes || !contentType) return { ok: false, code: 'photo_unavailable' };
    return { ok: true, bytes, contentType };
  } catch {
    // The port throws only when the platform is unreachable.
    return { ok: false, code: 'unreachable' };
  }
}
