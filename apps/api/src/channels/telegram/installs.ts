/**
 * Telegram install: one bot per project. The bot token and webhook secret live
 * in project secrets (connector-only); `chat_installs` records the bot id so
 * the install is a channel like Slack and Teams. Allowed senders and access
 * requests are `projects.metadata.telegram` (channels/core/channel-access.ts),
 * scoped to the bot id.
 */
import { chatInstalls, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  type ChannelAccessEntry,
  cleanName,
  clearChannelAccessRequests,
  readChannelAccess,
  recordChannelAccessRequest,
  setChannelAllowedUsers,
} from '../core/channel-access';
import { deleteProjectSecrets, readSecret, upsertSecret } from '../install-store';

export const TELEGRAM_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN';
/** Same name the legacy webhook verifies against, so one secret serves both paths. */
export const TELEGRAM_WEBHOOK_SECRET = 'TELEGRAM_WEBHOOK_SECRET';
export const TELEGRAM_BOT_USERNAME = 'TELEGRAM_BOT_USERNAME';

export const TELEGRAM_USER_ID = /^\d{1,20}$/;

export interface TelegramInstall {
  botId: string;
  username: string | null;
  allowedUserIds: string[];
  /** Requests still waiting: not allowed, under 30 days old, newest first. */
  accessRequests: ChannelAccessEntry[];
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
  if (previous?.botId !== input.botId) await clearChannelAccessRequests('telegram', input.projectId);
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
  return {
    botId: row.botId,
    username: await readSecret(projectId, TELEGRAM_BOT_USERNAME),
    ...readChannelAccess(row.metadata, 'telegram'),
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
  await clearChannelAccessRequests('telegram', projectId);
}

/** Replace the allowed sender list; drops the requests of the ids it allows. */
export function setTelegramAllowedUserIds(projectId: string, ids: string[]): Promise<void> {
  return setChannelAllowedUsers('telegram', projectId, ids);
}

/**
 * Record that a not-allowed user messaged the bot privately: only the id and
 * the names of `from` (channel-access.ts `recordChannelAccessRequest`). False
 * also when `from` has no valid Telegram user id.
 */
export async function recordTelegramAccessRequest(
  projectId: string,
  install: Pick<TelegramInstall, 'botId' | 'accessRequests'>,
  from: { id?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown },
): Promise<boolean> {
  const id = typeof from.id === 'number' && Number.isSafeInteger(from.id) && from.id > 0 ? String(from.id) : '';
  if (!TELEGRAM_USER_ID.test(id)) return false;
  return recordChannelAccessRequest('telegram', projectId, { scopeId: install.botId, accessRequests: install.accessRequests }, {
    id,
    username: cleanName(from.username, 32),
    first_name: cleanName(from.first_name, 64),
    last_name: cleanName(from.last_name, 64),
  });
}
