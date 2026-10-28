/**
 * Telegram install: one bot per project. The bot token and webhook secret live
 * in project secrets (connector-only); `chat_installs` records the bot id so
 * the install is a channel like Slack and Teams. Allowed senders stay where the
 * webhook already reads them: `projects.metadata.telegram.allowedUserIds`.
 * People who messaged the bot privately and are not allowed wait in
 * `projects.metadata.telegram.accessRequests` until an admin allows or
 * dismisses them.
 */
import { chatInstalls, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { metadataClearSubtreeKey, metadataMergeSubtree } from '../../projects/surface';
import { db } from '../../shared/db';
import { deleteProjectSecrets, readSecret, upsertSecret } from '../install-store';

export const TELEGRAM_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN';
/** Same name the legacy webhook verifies against, so one secret serves both paths. */
export const TELEGRAM_WEBHOOK_SECRET = 'TELEGRAM_WEBHOOK_SECRET';
export const TELEGRAM_BOT_USERNAME = 'TELEGRAM_BOT_USERNAME';

export const TELEGRAM_MAX_ALLOWED_USERS = 200;
export const TELEGRAM_USER_ID = /^\d{1,20}$/;
const MAX_ACCESS_REQUESTS = 20;
const ACCESS_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A repeat message within this long, under the same names, writes nothing. */
const ACCESS_REQUEST_THROTTLE_MS = 60 * 60 * 1000;

/** Who asked for access: only these fields of the message's `from`, never its text. */
export interface TelegramAccessRequestEntry {
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  last_seen: string;
}

export interface TelegramInstall {
  botId: string;
  username: string | null;
  allowedUserIds: string[];
  /** Requests still waiting: not allowed, under 30 days old, newest first. */
  accessRequests: TelegramAccessRequestEntry[];
}

export async function saveTelegramInstall(input: {
  projectId: string;
  botId: string;
  username: string | null;
  token: string;
  webhookSecret: string;
}): Promise<void> {
  // One bot per project: a reconnect with another bot retires the old row.
  const [previous] = await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'telegram'), eq(chatInstalls.projectId, input.projectId)))
    .returning({ botId: chatInstalls.workspaceId });
  await db
    .insert(chatInstalls)
    .values({ platform: 'telegram', workspaceId: input.botId, projectId: input.projectId })
    .onConflictDoNothing();
  // Requests to another bot are not requests to this one. After the insert: a
  // request still writing checks its bot under the row lock.
  if (previous?.botId !== input.botId) await clearTelegramAccessRequests(input.projectId);
  await upsertSecret(input.projectId, TELEGRAM_BOT_TOKEN, input.token);
  await upsertSecret(input.projectId, TELEGRAM_WEBHOOK_SECRET, input.webhookSecret);
  if (input.username) await upsertSecret(input.projectId, TELEGRAM_BOT_USERNAME, input.username);
}

export async function loadTelegramInstall(projectId: string): Promise<TelegramInstall | null> {
  const [row] = await db
    .select({ botId: chatInstalls.workspaceId, metadata: projects.metadata })
    .from(chatInstalls)
    .innerJoin(projects, eq(projects.projectId, chatInstalls.projectId))
    .where(and(eq(chatInstalls.platform, 'telegram'), eq(chatInstalls.projectId, projectId)))
    .limit(1);
  if (!row) return null;
  const allowedUserIds = telegramAllowedUserIds(row.metadata);
  return {
    botId: row.botId,
    username: await readSecret(projectId, TELEGRAM_BOT_USERNAME),
    allowedUserIds,
    accessRequests: waitingRequests(storedAccessRequests(row.metadata), allowedUserIds).sort(
      (a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen),
    ),
  };
}

export function loadTelegramBotToken(projectId: string): Promise<string | null> {
  return readSecret(projectId, TELEGRAM_BOT_TOKEN);
}

/** The secret Telegram sends with every update to this project's webhook. */
export function loadTelegramWebhookSecret(projectId: string): Promise<string | null> {
  return readSecret(projectId, TELEGRAM_WEBHOOK_SECRET);
}

export async function deleteTelegramInstall(projectId: string): Promise<void> {
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'telegram'), eq(chatInstalls.projectId, projectId)));
  await deleteProjectSecrets(projectId, [TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME]);
  // Requests were made to the old bot. The allowed list stays for a reconnect.
  await clearTelegramAccessRequests(projectId);
}

function clearTelegramAccessRequests(projectId: string) {
  return db
    .update(projects)
    .set({ metadata: metadataClearSubtreeKey('telegram', 'accessRequests') })
    .where(eq(projects.projectId, projectId));
}

export function telegramAllowedUserIds(metadata: unknown): string[] {
  const ids = (metadata as { telegram?: { allowedUserIds?: unknown } } | null)?.telegram?.allowedUserIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

/** Replace the allowed sender list in `projects.metadata.telegram.allowedUserIds`; drops the requests of the ids it allows. */
export async function setTelegramAllowedUserIds(projectId: string, ids: string[]): Promise<void> {
  await editTelegramLists(projectId, () => ({ allowedUserIds: ids }));
}

/** Every stored request, as written; a malformed entry is skipped. */
function storedAccessRequests(metadata: unknown): TelegramAccessRequestEntry[] {
  const list = (metadata as { telegram?: { accessRequests?: unknown } } | null)?.telegram?.accessRequests;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r): r is TelegramAccessRequestEntry =>
      typeof r?.id === 'string' && typeof r.last_seen === 'string' && !Number.isNaN(Date.parse(r.last_seen)),
  );
}

/** The requests still waiting: not allowed, and under 30 days old. */
function waitingRequests(requests: TelegramAccessRequestEntry[], allowedUserIds: string[]): TelegramAccessRequestEntry[] {
  const now = Date.now();
  return requests.filter((r) => !allowedUserIds.includes(r.id) && now - Date.parse(r.last_seen) < ACCESS_REQUEST_TTL_MS);
}

type TelegramLists = { allowedUserIds: string[]; accessRequests: TelegramAccessRequestEntry[] };

/**
 * Edit the allowed list and the requests under the project row's lock, so
 * concurrent edits (an admin's Allow, a new request) all land. `edit` gets the
 * waiting requests and returns the lists to write, or null for no change.
 * Every write drops expired requests and the requests of allowed ids, so a
 * removed user's old request never comes back. With `botId`, nothing is edited
 * unless the project still has that bot.
 */
async function editTelegramLists(
  projectId: string,
  edit: (lists: TelegramLists) => Partial<TelegramLists> | null,
  botId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .for('update');
    if (!row) return;
    if (botId) {
      // A disconnect or another bot's connect clears the requests after this check, or waits for this lock.
      const [install] = await tx
        .select({ botId: chatInstalls.workspaceId })
        .from(chatInstalls)
        .where(and(eq(chatInstalls.platform, 'telegram'), eq(chatInstalls.projectId, projectId), eq(chatInstalls.workspaceId, botId)))
        .limit(1);
      if (!install) return;
    }
    const stored = storedAccessRequests(row.metadata);
    const allowedUserIds = telegramAllowedUserIds(row.metadata);
    const waiting = waitingRequests(stored, allowedUserIds);
    const patch = edit({ allowedUserIds, accessRequests: waiting });
    const accessRequests = waitingRequests(patch?.accessRequests ?? waiting, patch?.allowedUserIds ?? allowedUserIds);
    if (patch || accessRequests.length !== stored.length) {
      await tx
        .update(projects)
        .set({ metadata: metadataMergeSubtree('telegram', { ...patch, accessRequests }) })
        .where(eq(projects.projectId, projectId));
    }
  });
}

/** Allow one user; the write drops their request. False: the list is full. */
export async function addTelegramAllowedUser(projectId: string, id: string): Promise<boolean> {
  let full = false;
  await editTelegramLists(projectId, ({ allowedUserIds }) => {
    if (allowedUserIds.includes(id)) return null;
    if (allowedUserIds.length >= TELEGRAM_MAX_ALLOWED_USERS) {
      full = true;
      return null;
    }
    return { allowedUserIds: [...allowedUserIds, id] };
  });
  return !full;
}

export async function removeTelegramAllowedUser(projectId: string, id: string): Promise<void> {
  await editTelegramLists(projectId, ({ allowedUserIds }) =>
    allowedUserIds.includes(id) ? { allowedUserIds: allowedUserIds.filter((u) => u !== id) } : null,
  );
}

export async function dismissTelegramAccessRequest(projectId: string, id: string): Promise<void> {
  await editTelegramLists(projectId, ({ accessRequests }) =>
    accessRequests.some((r) => r.id === id) ? { accessRequests: accessRequests.filter((r) => r.id !== id) } : null,
  );
}

/**
 * A Telegram name: a string without control or format characters (bidi
 * overrides and isolates, zero-width), at most `max` code points (never half an emoji).
 */
function cleanName(value: unknown, max: number): string | null {
  return typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, '')).slice(0, max).join('') || null : null;
}

/**
 * Record that a not-allowed user messaged the bot privately. Only the id and
 * the names of `from` are kept; the newest 20 requests under 30 days old stay.
 * A repeat within an hour under the same names writes nothing, and takes no
 * lock when the loaded `install` already shows it. Nothing is written once
 * `install`'s bot is gone. True: the request is stored. False: it is not (no
 * valid id, the user is allowed, or the bot is gone).
 */
export async function recordTelegramAccessRequest(
  projectId: string,
  install: Pick<TelegramInstall, 'botId' | 'accessRequests'>,
  from: { id?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown },
): Promise<boolean> {
  const id = typeof from.id === 'number' && Number.isSafeInteger(from.id) && from.id > 0 ? String(from.id) : '';
  if (!TELEGRAM_USER_ID.test(id)) return false;
  const now = Date.now();
  const entry: TelegramAccessRequestEntry = {
    id,
    username: cleanName(from.username, 32),
    first_name: cleanName(from.first_name, 64),
    last_name: cleanName(from.last_name, 64),
    last_seen: new Date(now).toISOString(),
  };
  const current = (requests: TelegramAccessRequestEntry[]) => {
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
  if (current(install.accessRequests)) return true;
  let stored = false;
  await editTelegramLists(
    projectId,
    ({ allowedUserIds, accessRequests }) => {
      if (allowedUserIds.includes(id)) return null;
      stored = true;
      if (current(accessRequests)) return null;
      return { accessRequests: [entry, ...accessRequests.filter((r) => r.id !== id)].slice(0, MAX_ACCESS_REQUESTS) };
    },
    install.botId,
  );
  return stored;
}
