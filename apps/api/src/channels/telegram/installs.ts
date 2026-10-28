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
import { and, eq, sql } from 'drizzle-orm';
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
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'telegram'), eq(chatInstalls.projectId, input.projectId)));
  await db
    .insert(chatInstalls)
    .values({ platform: 'telegram', workspaceId: input.botId, projectId: input.projectId })
    .onConflictDoNothing();
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
  const oldest = Date.now() - ACCESS_REQUEST_TTL_MS;
  return {
    botId: row.botId,
    username: await readSecret(projectId, TELEGRAM_BOT_USERNAME),
    allowedUserIds,
    accessRequests: storedAccessRequests(row.metadata)
      .filter((r) => !allowedUserIds.includes(r.id) && Date.parse(r.last_seen) > oldest)
      .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen)),
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
  await db
    .update(projects)
    .set({ metadata: metadataClearSubtreeKey('telegram', 'accessRequests') })
    .where(eq(projects.projectId, projectId));
}

export function telegramAllowedUserIds(metadata: unknown): string[] {
  const ids = (metadata as { telegram?: { allowedUserIds?: unknown } } | null)?.telegram?.allowedUserIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

/** Replace the allowed sender list in `projects.metadata.telegram.allowedUserIds`. */
export async function setTelegramAllowedUserIds(projectId: string, ids: string[]): Promise<void> {
  await db
    .update(projects)
    .set({
      metadata: sql`jsonb_set(
        jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), '{telegram}', coalesce(${projects.metadata}->'telegram', '{}'::jsonb)),
        '{telegram,allowedUserIds}', ${JSON.stringify(ids)}::jsonb)`,
    })
    .where(eq(projects.projectId, projectId));
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

type TelegramLists = { allowedUserIds: string[]; accessRequests: TelegramAccessRequestEntry[] };

/**
 * Edit the allowed list and the requests under the project row's lock, so
 * concurrent edits (an admin's Allow, a new request) all land. `edit` returns
 * the lists to write, or null to write nothing. False: no such project.
 */
async function editTelegramLists(projectId: string, edit: (lists: TelegramLists) => Partial<TelegramLists> | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .for('update');
    if (!row) return false;
    const patch = edit({ allowedUserIds: telegramAllowedUserIds(row.metadata), accessRequests: storedAccessRequests(row.metadata) });
    if (patch) await tx.update(projects).set({ metadata: metadataMergeSubtree('telegram', patch) }).where(eq(projects.projectId, projectId));
    return true;
  });
}

/** Allow one user and drop their request. False: the list is full. */
export async function addTelegramAllowedUser(projectId: string, id: string): Promise<boolean> {
  let full = false;
  await editTelegramLists(projectId, ({ allowedUserIds, accessRequests }) => {
    const requests = accessRequests.filter((r) => r.id !== id);
    if (allowedUserIds.includes(id)) return requests.length === accessRequests.length ? null : { accessRequests: requests };
    if (allowedUserIds.length >= TELEGRAM_MAX_ALLOWED_USERS) {
      full = true;
      return null;
    }
    return { allowedUserIds: [...allowedUserIds, id], accessRequests: requests };
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

/** A Telegram name: a string, without control characters, at most `max` code points (never half an emoji). */
function cleanName(value: unknown, max: number): string | null {
  return typeof value === 'string' ? Array.from(value.replace(/\p{Cc}/gu, '')).slice(0, max).join('') || null : null;
}

/**
 * Record that a not-allowed user messaged the bot privately. Only the id and
 * the names of `from` are kept; the newest 20 requests under 30 days old stay.
 * A repeat within an hour under the same names writes nothing.
 */
export async function recordTelegramAccessRequest(
  projectId: string,
  from: { id?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown },
): Promise<void> {
  const id = typeof from.id === 'number' && Number.isSafeInteger(from.id) && from.id > 0 ? String(from.id) : '';
  if (!TELEGRAM_USER_ID.test(id)) return;
  const now = Date.now();
  const entry: TelegramAccessRequestEntry = {
    id,
    username: cleanName(from.username, 32),
    first_name: cleanName(from.first_name, 64),
    last_name: cleanName(from.last_name, 64),
    last_seen: new Date(now).toISOString(),
  };
  await editTelegramLists(projectId, ({ allowedUserIds, accessRequests }) => {
    if (allowedUserIds.includes(id)) return null;
    const previous = accessRequests.find((r) => r.id === id);
    if (
      previous &&
      now - Date.parse(previous.last_seen) < ACCESS_REQUEST_THROTTLE_MS &&
      previous.username === entry.username &&
      previous.first_name === entry.first_name &&
      previous.last_name === entry.last_name
    ) {
      return null;
    }
    const kept = accessRequests.filter((r) => r.id !== id && now - Date.parse(r.last_seen) < ACCESS_REQUEST_TTL_MS);
    return { accessRequests: [entry, ...kept].slice(0, MAX_ACCESS_REQUESTS) };
  });
}
