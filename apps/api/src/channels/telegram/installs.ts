/**
 * Telegram install: one bot per project. The bot token and webhook secret live
 * in project secrets (connector-only); `chat_installs` records the bot id so
 * the install is a channel like Slack and Teams. Allowed senders stay where the
 * webhook already reads them: `projects.metadata.telegram.allowedUserIds`.
 */
import { chatInstalls, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { deleteProjectSecrets, readSecret, upsertSecret } from '../install-store';

export const TELEGRAM_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN';
/** Same name the legacy webhook verifies against, so one secret serves both paths. */
export const TELEGRAM_WEBHOOK_SECRET = 'TELEGRAM_WEBHOOK_SECRET';
export const TELEGRAM_BOT_USERNAME = 'TELEGRAM_BOT_USERNAME';

export interface TelegramInstall {
  botId: string;
  username: string | null;
  allowedUserIds: string[];
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
  return {
    botId: row.botId,
    username: await readSecret(projectId, TELEGRAM_BOT_USERNAME),
    allowedUserIds: telegramAllowedUserIds(row.metadata),
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
