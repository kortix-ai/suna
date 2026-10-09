// One notification preference record per user (KRTX-1742). The table stores
// only the user's overrides; the effective record is the shared defaults with
// those overrides merged in, so a new kind gets its default without a backfill.
import { inArray, sql } from 'drizzle-orm';
import { notificationPreferences, type Database } from '@kortix/db';
import {
  NOTIFICATION_KINDS,
  effectiveNotificationPreferences,
  type NotificationChannelPreference,
  type NotificationKindName,
  type NotificationKindPreferences,
} from '@kortix/shared/notification-kinds';
import { db as defaultDb } from '../shared/db';

export type NotificationPreferencesPatch = {
  kinds?: Partial<Record<NotificationKindName, Partial<NotificationChannelPreference>>>;
};

/** Effective preferences for each user; a user with no record gets the defaults. */
export async function loadEffectivePreferences(
  userIds: readonly string[],
  database: Database = defaultDb,
): Promise<Map<string, NotificationKindPreferences>> {
  const out = new Map<string, NotificationKindPreferences>();
  if (userIds.length === 0) return out;
  const rows = await database
    .select({ userId: notificationPreferences.userId, settings: notificationPreferences.settings })
    .from(notificationPreferences)
    .where(inArray(notificationPreferences.userId, [...userIds]));
  const stored = new Map(rows.map((row) => [row.userId, row.settings]));
  for (const userId of userIds) out.set(userId, effectiveNotificationPreferences(stored.get(userId)));
  return out;
}

/** Keep only known kinds and boolean channel values. */
export function sanitizePreferencesPatch(patch: NotificationPreferencesPatch): NotificationPreferencesPatch {
  const kinds: Partial<Record<NotificationKindName, Partial<NotificationChannelPreference>>> = {};
  for (const kind of NOTIFICATION_KINDS) {
    const value = patch.kinds?.[kind];
    if (!value) continue;
    const clean: Partial<NotificationChannelPreference> = {};
    if (typeof value.push === 'boolean') clean.push = value.push;
    if (typeof value.email === 'boolean') clean.email = value.email;
    if (Object.keys(clean).length > 0) kinds[kind] = clean;
  }
  return { kinds };
}

/**
 * Merge `patch` into the user's stored overrides and return the effective
 * record. One statement: concurrent saves of different kinds both survive.
 */
export async function updateNotificationPreferences(
  userId: string,
  patch: NotificationPreferencesPatch,
  database: Database = defaultDb,
): Promise<NotificationKindPreferences> {
  const clean = sanitizePreferencesPatch(patch);
  const kinds = JSON.stringify(clean.kinds ?? {});
  const [row] = await database
    .insert(notificationPreferences)
    .values({ userId, settings: { kinds: clean.kinds ?? {} } })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      // Per-kind merge: {kinds: {question: {email:false}}} keeps question.push.
      set: {
        settings: sql`jsonb_set(
          ${notificationPreferences.settings},
          '{kinds}',
          (
            SELECT coalesce(jsonb_object_agg(k, coalesce(${notificationPreferences.settings} -> 'kinds' -> k, '{}'::jsonb) || v), '{}'::jsonb)
            FROM jsonb_each(${kinds}::jsonb) AS e(k, v)
          ) || (coalesce(${notificationPreferences.settings} -> 'kinds', '{}'::jsonb) - ARRAY(SELECT jsonb_object_keys(${kinds}::jsonb)))
        )`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ settings: notificationPreferences.settings });
  return effectiveNotificationPreferences(row?.settings);
}
