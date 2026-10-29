/**
 * The bot's command menu (the list Telegram shows after "/"): Kortix's commands
 * (core/command-list.ts) first, then every entry the bot's owner set in
 * BotFather. Only the default scope, with no language.
 *
 *   connect     → merge now
 *   a message   → merge once per bot and menu version, in the background
 *   disconnect  → take Kortix's entries out, keep the owner's
 *
 * Imports no module that imports the installs: installs.ts imports this file.
 */
import { createHash } from 'node:crypto';
import { chatEventDedup } from '@kortix/db';
import { eq, like } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { commandMenu } from '../core/command-list';
import { claimThreadCreate } from '../core/threads';
import { telegramCall, telegramUnreachable } from './api';

type MenuEntry = { command: string; description: string };

const MENU = commandMenu();
const OURS = new Set(MENU.map((c) => c.command));
/** Long-lived: an entry the owner removes in BotFather stays removed until the menu changes or the bot reconnects. */
const MENU_CLAIM_TTL_MS = 365 * 24 * 60 * 60_000;
const MENU_CALL_TIMEOUT_MS = 3_000;

/** One merge per bot and menu version: a change to the commands changes the key, so every bot merges once after that deploy. */
export const telegramMenuClaim = (botId: string) =>
  `telegram:commands:${botId}:${createHash('sha256').update(JSON.stringify(MENU)).digest('hex').slice(0, 12)}`;

/** Merge Kortix's commands into the bot's menu once per bot and menu version. Awaits only the claim; never throws. */
export async function repairTelegramMenu(token: string, botId: string, opts: { force?: boolean } = {}): Promise<void> {
  const claimed = await claimThreadCreate(telegramMenuClaim(botId), MENU_CLAIM_TTL_MS).catch((error) => {
    logger.warn('[telegram] bot menu claim not read', { botId, error: String(error) });
    return null;
  });
  if (claimed || opts.force) void mergeTelegramMenu(token, botId);
}

/**
 * Kortix's commands first, then the bot's other entries, at most 100. Writes only a change. When
 * Telegram does not answer, the claim goes, so a later message retries; a refusal keeps it. Never throws.
 */
export async function mergeTelegramMenu(token: string, botId: string): Promise<void> {
  try {
    const current = await telegramCall<unknown>(token, 'getMyCommands', {}, MENU_CALL_TIMEOUT_MS);
    if (!Array.isArray(current)) return;
    const next = [...MENU, ...(current as MenuEntry[]).filter((c) => !OURS.has(c.command))].slice(0, 100);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await telegramCall(token, 'setMyCommands', { commands: next }, MENU_CALL_TIMEOUT_MS);
    }
  } catch (error) {
    logger.warn('[telegram] bot menu not merged', { botId, error: String(error) });
    if (telegramUnreachable(error)) {
      await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, telegramMenuClaim(botId))).catch(() => undefined);
    }
  }
}

/** Take only Kortix's commands out of the bot's menu, then forget its merges. Throws on a Telegram error. */
export async function removeTelegramMenu(token: string): Promise<void> {
  const current = await telegramCall<unknown>(token, 'getMyCommands', {}, MENU_CALL_TIMEOUT_MS);
  if (Array.isArray(current)) {
    const rest = (current as MenuEntry[]).filter((c) => !OURS.has(c.command));
    if (rest.length !== current.length) {
      await (rest.length
        ? telegramCall(token, 'setMyCommands', { commands: rest }, MENU_CALL_TIMEOUT_MS)
        : telegramCall(token, 'deleteMyCommands', {}, MENU_CALL_TIMEOUT_MS));
    }
  }
  // A bot token is `<bot id>:<secret>` (api.ts TELEGRAM_TOKEN_PATTERN).
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `telegram:commands:${token.split(':')[0]}:%`));
}
