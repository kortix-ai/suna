// Storage for Expo push device tokens (`kortix.push_device_tokens`).
//
// One row per device token. The token is the primary key, so a device that
// signs in as another user moves to that user on its next registration.
// Consumers: the device-token routes (register / unregister) and
// the push sender (list a user's tokens, drop tokens Expo reports as gone).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { pushDeviceTokens, type Database } from '@kortix/db';
import { db as defaultDb } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';

export type PushPlatform = 'ios' | 'android';

/** Per-device notification switches. Every key defaults to true. */
export interface PushPreferences {
  enabled: boolean;
  onCompletion: boolean;
  onError: boolean;
  onQuestion: boolean;
  onPermission: boolean;
  playSound: boolean;
}

export type PushDeviceTokenRow = typeof pushDeviceTokens.$inferSelect;

export interface UpsertDeviceTokenInput {
  token: string;
  userId: string;
  platform: PushPlatform;
  provider: 'expo';
  /** Keys that are absent keep their stored value (or the column default on insert). */
  preferences?: Partial<PushPreferences>;
  /** The caller's sign-in (`auth.sessions.id`); absent for a personal token. */
  authSessionId?: string | null;
}

export interface PushDeviceTokenStore {
  /** Insert or update the row for `token`. The row always ends up owned by `userId`. */
  upsert(input: UpsertDeviceTokenInput): Promise<PushDeviceTokenRow>;
  /** Delete `token` only when `userId` owns it. Returns true when a row was deleted. */
  deleteForUser(token: string, userId: string): Promise<boolean>;
  /**
   * The tokens of `userId` whose registering sign-in still exists. A device
   * signed out (Settings > Security, GoTrue's sign-out of other devices, an
   * expired session) gets no push. A token with no recorded sign-in counts as
   * live; the app re-registers on every signed-in launch.
   */
  listByUser(userId: string): Promise<PushDeviceTokenRow[]>;
  /** Delete the given tokens regardless of owner. Returns the deleted count. */
  deleteTokens(tokens: readonly string[]): Promise<number>;
}

const PREFERENCE_COLUMNS = {
  enabled: 'enabled',
  onCompletion: 'onCompletion',
  onError: 'onError',
  onQuestion: 'onQuestion',
  onPermission: 'onPermission',
  playSound: 'playSound',
} as const satisfies Record<keyof PushPreferences, keyof PushDeviceTokenRow>;

function definedPreferences(preferences: Partial<PushPreferences> | undefined): Partial<PushPreferences> {
  const out: Partial<PushPreferences> = {};
  if (!preferences) return out;
  for (const key of Object.keys(PREFERENCE_COLUMNS) as (keyof PushPreferences)[]) {
    const value = preferences[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function createPushDeviceTokenStore(database: Database = defaultDb): PushDeviceTokenStore {
  return {
    async upsert({ token, userId, platform, provider, preferences, authSessionId = null }) {
      const prefs = definedPreferences(preferences);
      const [row] = await database
        .insert(pushDeviceTokens)
        .values({ token, userId, platform, provider, authSessionId, ...prefs })
        .onConflictDoUpdate({
          target: pushDeviceTokens.token,
          set: { userId, platform, provider, authSessionId, ...prefs, updatedAt: sql`now()` },
        })
        .returning();
      if (!row) throw new Error('push device token upsert returned no row');
      return row;
    },

    async deleteForUser(token, userId) {
      const deleted = await database
        .delete(pushDeviceTokens)
        .where(and(eq(pushDeviceTokens.token, token), eq(pushDeviceTokens.userId, userId)))
        .returning({ token: pushDeviceTokens.token });
      return deleted.length > 0;
    },

    async listByUser(userId) {
      const signIn = qualifiedColumn(pushDeviceTokens.authSessionId);
      return database
        .select()
        .from(pushDeviceTokens)
        .where(
          and(
            eq(pushDeviceTokens.userId, userId),
            sql`(${signIn} IS NULL OR EXISTS (
              SELECT 1 FROM auth.sessions s
              WHERE s.id = ${signIn} AND (s.not_after IS NULL OR s.not_after > now())))`,
          ),
        );
    },

    async deleteTokens(tokens) {
      if (tokens.length === 0) return 0;
      const deleted = await database
        .delete(pushDeviceTokens)
        .where(inArray(pushDeviceTokens.token, [...tokens]))
        .returning({ token: pushDeviceTokens.token });
      return deleted.length;
    },
  };
}

let defaultStore: PushDeviceTokenStore | null = null;

/** The process-wide store on the API's shared database connection. */
export function pushDeviceTokenStore(): PushDeviceTokenStore {
  defaultStore ??= createPushDeviceTokenStore();
  return defaultStore;
}
