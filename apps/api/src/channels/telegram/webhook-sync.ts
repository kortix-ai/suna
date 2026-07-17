/**
 * Startup re-registration of Telegram webhooks.
 *
 * Quick Cloudflare tunnels (local dev) rotate their public URL every few hours;
 * the dev watchdog restarts the API with the fresh KORTIX_URL, but the bot's
 * webhook still points at the dead URL — inbound messages silently stop. This
 * re-points every connected bot's webhook at the CURRENT KORTIX_URL on boot.
 *
 * Runs leader-gated (startSingletonWorkers) so multiple prod replicas don't all
 * hammer Telegram; and only calls setWebhook when the URL actually differs
 * (getWebhookInfo compare), so on a stable prod URL it's a no-op after the first
 * check. Skipped entirely when KORTIX_URL isn't a public https origin.
 */

import { chatInstalls } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../shared/db';
import { loadTelegramTokenForProject, loadTelegramWebhookSecretForProject } from '../install-store';
import {
  buildTelegramWebhookUrl,
  telegramGetWebhookInfo,
  telegramSetWebhook,
} from '../telegram-api';

/** The webhook URL we'd register for a project given a public base — or null
 *  when the base isn't a usable public https origin (localhost / no tunnel), in
 *  which case there's nothing to point Telegram at. Pure + unit-tested. */
export function telegramWebhookResyncTarget(
  base: string | undefined | null,
  projectId: string,
): string | null {
  const trimmed = (base ?? '').trim();
  if (!/^https:\/\//.test(trimmed)) return null;
  if (/^https:\/\/localhost|^https:\/\/127\.0\.0\.1/.test(trimmed)) return null;
  return buildTelegramWebhookUrl(trimmed, projectId);
}

async function distinctTelegramProjectIds(): Promise<string[]> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(eq(chatInstalls.platform, 'telegram'));
  return Array.from(new Set(rows.map((r) => r.projectId)));
}

/** Re-point every connected Telegram bot's webhook at the current KORTIX_URL.
 *  Best-effort and idempotent — safe to call on every boot / leadership flap. */
export async function resyncTelegramWebhooks(): Promise<void> {
  if (telegramWebhookResyncTarget(config.KORTIX_URL, 'probe') === null) return;

  let projectIds: string[];
  try {
    projectIds = await distinctTelegramProjectIds();
  } catch (err) {
    console.warn('[telegram-resync] could not list installs', err);
    return;
  }
  if (projectIds.length === 0) return;

  let resynced = 0;
  for (const projectId of projectIds) {
    const expected = telegramWebhookResyncTarget(config.KORTIX_URL, projectId);
    if (!expected) return; // KORTIX_URL changed underneath us; bail cleanly
    try {
      const [token, secret] = await Promise.all([
        loadTelegramTokenForProject(projectId),
        loadTelegramWebhookSecretForProject(projectId),
      ]);
      if (!token || !secret) continue;
      const info = await telegramGetWebhookInfo(token);
      if (info?.url === expected) continue; // already correct — skip the write
      const res = await telegramSetWebhook(token, expected, secret);
      if (res.ok) resynced++;
      else console.warn('[telegram-resync] setWebhook failed for project', projectId, res.error);
    } catch (err) {
      console.warn('[telegram-resync] failed for project', projectId, err);
    }
  }
  if (resynced > 0) {
    console.log(`[telegram-resync] re-pointed ${resynced} webhook(s) at ${config.KORTIX_URL}`);
  }
}
