/**
 * Who the bot's allowed users and access requests are: names and the photo
 * version from `getChat`, and the photo bytes through `getFile`. The token and
 * the file URL stay on the server; the web reads the photo through the API.
 */
import { mapWithConcurrency } from '../../shared/map-with-concurrency';
import { telegramCall, telegramDownload, telegramUnreachable } from './api';
import { cleanName, loadTelegramBotToken, loadTelegramInstall, type TelegramAccessRequestEntry } from './installs';

export interface TelegramUser {
  user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  /** The small photo's `file_unique_id`; null: no photo. */
  photo_version: string | null;
  /** False: Telegram gave no profile and nothing is stored. */
  known: boolean;
}

export type TelegramAccessRequest = TelegramUser & { last_seen: string };

interface TelegramProfile {
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  photo: { file_id: string; unique_id: string } | null;
}

const PROFILE_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const PROFILE_TIMEOUT_MS = 3_000;
/** No new `getChat` starts after this long, so a list of 200 stays under the request deadline. */
const LIST_BUDGET_MS = 8_000;
const MAX_PROFILES = 1_000;
const MAX_PHOTO_BYTES = 1024 * 1024;

// replica-local: getChat answers per (bot, user), 10 min for a profile and 60 s for a miss; a cold replica asks Telegram again.
const profiles = new Map<string, { expires: number; value: Promise<TelegramProfile | null> }>();

const str = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** Null: Telegram has no chat with this user (never started the bot, or blocked it). Throws when Telegram is unreachable. */
async function fetchProfile(token: string, userId: string): Promise<TelegramProfile | null> {
  try {
    const chat = await telegramCall<Record<string, unknown>>(token, 'getChat', { chat_id: userId }, PROFILE_TIMEOUT_MS);
    const photo = chat.photo as { small_file_id?: unknown; small_file_unique_id?: unknown } | undefined;
    const fileId = str(photo?.small_file_id);
    const uniqueId = str(photo?.small_file_unique_id);
    return {
      // Names from Telegram get the same cleaning as a stored request's.
      username: cleanName(chat.username, 32),
      first_name: cleanName(chat.first_name, 64),
      last_name: cleanName(chat.last_name, 64),
      photo: fileId && uniqueId ? { file_id: fileId, unique_id: uniqueId } : null,
    };
  } catch (error) {
    if (telegramUnreachable(error)) throw error;
    return null;
  }
}

/** The cached profile; `cacheOnly` starts no `getChat` and answers null on a miss. */
function telegramProfile(token: string, botId: string, userId: string, cacheOnly = false): Promise<TelegramProfile | null> {
  // A file id is valid only for the bot that read it.
  const key = `${botId}:${userId}`;
  const hit = profiles.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (cacheOnly) return Promise.resolve(null);
  const entry = { expires: Date.now() + MISS_TTL_MS, value: fetchProfile(token, userId) };
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

function telegramUser(userId: string, profile: TelegramProfile | null, stored?: TelegramAccessRequestEntry): TelegramUser {
  const names = profile ?? stored;
  return {
    user_id: userId,
    username: names?.username ?? null,
    first_name: names?.first_name ?? null,
    last_name: names?.last_name ?? null,
    photo_version: profile?.photo?.unique_id ?? null,
    known: !!names,
  };
}

/**
 * The allowed users in list order and the waiting requests newest first, each
 * with its Telegram profile. A failed lookup falls back to the names a
 * request stored, else `known: false`; it never fails the list. Null: no bot.
 */
export async function listTelegramUsers(
  projectId: string,
): Promise<{ allowed: TelegramUser[]; requests: TelegramAccessRequest[] } | null> {
  const [install, token] = await Promise.all([loadTelegramInstall(projectId), loadTelegramBotToken(projectId)]);
  if (!install) return null;
  const deadline = Date.now() + LIST_BUDGET_MS;
  const profile = (userId: string) =>
    token ? telegramProfile(token, install.botId, userId, Date.now() > deadline).catch(() => null) : Promise.resolve(null);
  const allowedCount = install.allowedUserIds.length;
  const found = await mapWithConcurrency([...install.allowedUserIds, ...install.accessRequests.map((r) => r.id)], 5, profile);
  return {
    allowed: install.allowedUserIds.map((id, i) => telegramUser(id, found[i] ?? null)),
    requests: install.accessRequests.map((r, i) => ({ ...telegramUser(r.id, found[allowedCount + i] ?? null, r), last_seen: r.last_seen })),
  };
}

export type TelegramPhoto =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; code: 'telegram_not_connected' | 'telegram_user_unknown' | 'telegram_photo_unavailable' | 'telegram_unreachable' };

/** A listed user's small profile photo (JPEG). Only an allowed or requesting user: the bot is no lookup service. */
export async function telegramUserPhoto(projectId: string, userId: string): Promise<TelegramPhoto> {
  const [install, token] = await Promise.all([loadTelegramInstall(projectId), loadTelegramBotToken(projectId)]);
  if (!install || !token) return { ok: false, code: 'telegram_not_connected' };
  if (!install.allowedUserIds.includes(userId) && !install.accessRequests.some((r) => r.id === userId)) {
    return { ok: false, code: 'telegram_user_unknown' };
  }
  try {
    const photo = (await telegramProfile(token, install.botId, userId))?.photo;
    if (!photo) return { ok: false, code: 'telegram_photo_unavailable' };
    const file = await telegramCall<{ file_path?: string }>(token, 'getFile', { file_id: photo.file_id }, 5_000);
    if (!file.file_path) return { ok: false, code: 'telegram_photo_unavailable' };
    const bytes = await telegramDownload(token, file.file_path, MAX_PHOTO_BYTES);
    // Telegram profile photos are JPEG; anything else is not served as one.
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return { ok: false, code: 'telegram_photo_unavailable' };
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, code: telegramUnreachable(error) ? 'telegram_unreachable' : 'telegram_photo_unavailable' };
  }
}
