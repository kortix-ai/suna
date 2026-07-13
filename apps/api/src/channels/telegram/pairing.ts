/**
 * Pure pairing logic for the Telegram sender allowlist.
 *
 * The inbound webhook only spawns agent turns for senders in
 * `projects.metadata.telegram.allowedUserIds` (see telegram-webhook.ts gate).
 * Pairing is how a human gets onto that list without hunting for their numeric
 * Telegram id: the dashboard mints a short-lived single-use code, the user
 * sends `/start <code>` to the bot, and the webhook adds their sender id.
 *
 * Everything here is framework- and DB-free so it's unit-testable; storage
 * lives in install-store.ts and enforcement in telegram-webhook.ts.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const TELEGRAM_PAIRING_TTL_MS = 15 * 60 * 1000;

// Exactly 32 chars (I, O, 0, 1 dropped as look-alikes) so `byte & 31` maps a
// random byte to the alphabet with zero modulo bias.
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface TelegramPairing {
  code: string;
  expiresAt: string;
}

/** `XXXX-XXXX` from 8 random bytes (~40 bits) — plenty for a 15-minute
 *  single-use code whose only oracle is a Telegram message per guess. */
export function generateTelegramPairingCode(randomBytes: Uint8Array): string {
  if (randomBytes.length < 8) throw new Error('pairing code needs 8 random bytes');
  const chars = Array.from(randomBytes.slice(0, 8), (b) => PAIRING_ALPHABET[b & 31]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Case/format-forgiving: `abcd-2345`, `ABCD 2345`, and `ABCD2345` all match. */
export function normalizeTelegramPairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Constant-time match (sha256 digests, so length never short-circuits) plus
 *  expiry — a stored code is only as valid as its window. */
export function telegramPairingMatches(
  pairing: TelegramPairing,
  presented: string,
  now: Date,
): boolean {
  const expires = Date.parse(pairing.expiresAt);
  if (!Number.isFinite(expires) || now.getTime() > expires) return false;
  const digest = (value: string) =>
    createHash('sha256').update(normalizeTelegramPairingCode(value)).digest();
  return timingSafeEqual(digest(pairing.code), digest(presented));
}

export function telegramAllowedUserIds(metadata: unknown): string[] {
  const ids = (metadata as { telegram?: { allowedUserIds?: unknown } } | null | undefined)?.telegram
    ?.allowedUserIds;
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id)).filter(Boolean);
}

function withAllowedUserIds(metadata: unknown, ids: string[]): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const telegram =
    base.telegram && typeof base.telegram === 'object'
      ? (base.telegram as Record<string, unknown>)
      : {};
  return { ...base, telegram: { ...telegram, allowedUserIds: ids } };
}

/** Merged project metadata with the sender allowlisted — idempotent, preserves
 *  every unrelated metadata key. */
export function addTelegramAllowedUser(
  metadata: unknown,
  senderId: string | number,
): Record<string, unknown> {
  const id = String(senderId);
  const ids = telegramAllowedUserIds(metadata);
  return withAllowedUserIds(metadata, ids.includes(id) ? ids : [...ids, id]);
}

export function removeTelegramAllowedUser(
  metadata: unknown,
  senderId: string,
): { metadata: Record<string, unknown>; removed: boolean } {
  const ids = telegramAllowedUserIds(metadata);
  const next = ids.filter((id) => id !== senderId);
  return { metadata: withAllowedUserIds(metadata, next), removed: next.length !== ids.length };
}
