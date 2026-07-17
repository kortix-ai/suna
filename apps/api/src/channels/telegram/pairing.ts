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

/** Human-readable pairing profile, captured from the Telegram `from` at
 *  `/start` time (or backfilled via getChat) so the dashboard can show a name
 *  and @username instead of a bare numeric id. All fields optional — a legacy
 *  id with no captured profile still renders (as just the id). */
export interface TelegramUserProfile {
  firstName?: string;
  lastName?: string;
  username?: string;
  pairedAt?: string;
}

export interface TelegramAllowedUser extends TelegramUserProfile {
  id: string;
}

/** The `id → profile` map living beside `allowedUserIds`. Kept separate so the
 *  allowlist gate (which only needs ids) never has to parse profile data. */
export function telegramAllowedUserProfiles(
  metadata: unknown,
): Record<string, TelegramUserProfile> {
  const profiles = (
    metadata as { telegram?: { allowedUserProfiles?: unknown } } | null | undefined
  )?.telegram?.allowedUserProfiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return {};
  return profiles as Record<string, TelegramUserProfile>;
}

/** The allowlist as display rows: every allowed id, enriched with any captured
 *  profile, in allowlist order. */
export function telegramAllowedUsers(metadata: unknown): TelegramAllowedUser[] {
  const profiles = telegramAllowedUserProfiles(metadata);
  return telegramAllowedUserIds(metadata).map((id) => {
    const p = profiles[id];
    return {
      id,
      ...(p?.firstName ? { firstName: p.firstName } : {}),
      ...(p?.lastName ? { lastName: p.lastName } : {}),
      ...(p?.username ? { username: p.username } : {}),
      ...(p?.pairedAt ? { pairedAt: p.pairedAt } : {}),
    };
  });
}

function mergeTelegramMetadata(
  metadata: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const telegram =
    base.telegram && typeof base.telegram === 'object'
      ? (base.telegram as Record<string, unknown>)
      : {};
  return { ...base, telegram: { ...telegram, ...patch } };
}

function pruneProfile(profile: TelegramUserProfile): TelegramUserProfile {
  return {
    ...(profile.firstName ? { firstName: profile.firstName } : {}),
    ...(profile.lastName ? { lastName: profile.lastName } : {}),
    ...(profile.username ? { username: profile.username } : {}),
    ...(profile.pairedAt ? { pairedAt: profile.pairedAt } : {}),
  };
}

/** Merged project metadata with the sender allowlisted — idempotent, preserves
 *  every unrelated metadata key. An optional `profile` records the sender's
 *  name/username for display; `pairedAt` is stamped once (never overwritten on
 *  a re-pair) and captured fields only ever fill blanks, never clobber. */
export function addTelegramAllowedUser(
  metadata: unknown,
  senderId: string | number,
  profile?: TelegramUserProfile,
): Record<string, unknown> {
  const id = String(senderId);
  const ids = telegramAllowedUserIds(metadata);
  const nextIds = ids.includes(id) ? ids : [...ids, id];
  const profiles = telegramAllowedUserProfiles(metadata);
  const existing = profiles[id];
  const merged: TelegramUserProfile = {
    firstName: profile?.firstName ?? existing?.firstName,
    lastName: profile?.lastName ?? existing?.lastName,
    username: profile?.username ?? existing?.username,
    pairedAt: existing?.pairedAt ?? profile?.pairedAt,
  };
  const nextProfiles =
    profile || existing ? { ...profiles, [id]: pruneProfile(merged) } : profiles;
  return mergeTelegramMetadata(metadata, {
    allowedUserIds: nextIds,
    allowedUserProfiles: nextProfiles,
  });
}

export function removeTelegramAllowedUser(
  metadata: unknown,
  senderId: string,
): { metadata: Record<string, unknown>; removed: boolean } {
  const ids = telegramAllowedUserIds(metadata);
  const next = ids.filter((id) => id !== senderId);
  const profiles = telegramAllowedUserProfiles(metadata);
  const { [senderId]: _dropped, ...nextProfiles } = profiles;
  return {
    metadata: mergeTelegramMetadata(metadata, {
      allowedUserIds: next,
      allowedUserProfiles: nextProfiles,
    }),
    removed: next.length !== ids.length,
  };
}
