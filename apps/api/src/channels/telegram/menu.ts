/**
 * The bot's command menu (the list Telegram shows after "/"): Kortix's commands
 * (core/command-list.ts) first, then every entry the bot's owner set in
 * BotFather. Only the default scope, with no language. An owner's entry never
 * goes: a Kortix command whose name the owner uses, or that does not fit under
 * Telegram's 100, is left out.
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
/** Telegram's limit on one menu. */
const MENU_MAX = 100;
// ponytail: an entry is Kortix's when its name and description match today's menu, so an owner's
// same-named entry stays theirs. A changed description leaves the old entry as the owner's in every
// bot that merged it. Upgrade: store the entries Kortix wrote per bot.
const ours = (c: MenuEntry) => MENU.some((m) => m.command === c.command && m.description === c.description);
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
 * Kortix's commands first, then every entry of the owner's. Writes only a change. When Telegram does
 * not answer, the claim goes, so a later message retries; a refusal keeps it. Never throws.
 */
export async function mergeTelegramMenu(token: string, botId: string): Promise<void> {
  try {
    const current = await telegramCall<unknown>(token, 'getMyCommands', {}, MENU_CALL_TIMEOUT_MS);
    if (!Array.isArray(current)) return;
    const owner = (current as MenuEntry[]).filter((c) => !ours(c));
    const taken = new Set(owner.map((c) => c.command));
    const next = [...MENU.filter((c) => !taken.has(c.command)).slice(0, Math.max(0, MENU_MAX - owner.length)), ...owner];
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

/** Take only the entries Kortix wrote out of the bot's menu, then forget its merges. Throws on a Telegram error. */
export async function removeTelegramMenu(token: string): Promise<void> {
  const current = await telegramCall<unknown>(token, 'getMyCommands', {}, MENU_CALL_TIMEOUT_MS);
  if (Array.isArray(current)) {
    const rest = (current as MenuEntry[]).filter((c) => !ours(c));
    if (rest.length !== current.length) {
      await (rest.length
        ? telegramCall(token, 'setMyCommands', { commands: rest }, MENU_CALL_TIMEOUT_MS)
        : telegramCall(token, 'deleteMyCommands', {}, MENU_CALL_TIMEOUT_MS));
    }
  }
  // A bot token is `<bot id>:<secret>` (api.ts TELEGRAM_TOKEN_PATTERN).
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `telegram:commands:${token.split(':')[0]}:%`));
}
