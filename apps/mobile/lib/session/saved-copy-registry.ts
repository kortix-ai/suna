/**
 * The device's store of saved copies (`createSavedCopyStore`), kept on the
 * signed-in user: the same lifecycle as the persisted query cache
 * (lib/query/query-cache.ts). A sign-in keeps that user's copies; another user,
 * or a sign-out, forgets the previous user's. `lib/session/saved-copy.ts`
 * paints from the registered store while a session's computer wakes.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createSavedCopyStore, currentSavedCopyStore, setSavedCopyStore } from '@kortix/sdk';

let boundUserId: string | null = null;

/** Keep the store on `userId`; `null` stops painting saved copies. */
export function bindSavedCopies(userId: string | null): void {
  if (userId === boundUserId) return;
  const previous = currentSavedCopyStore();
  boundUserId = userId;
  setSavedCopyStore(userId ? createSavedCopyStore({ storage: AsyncStorage, userId }) : null);
  // Another user's copies never stay on the device beside this user's.
  if (previous) void previous.clear().catch(() => undefined);
}

/** Sign-out: stop painting saved copies and forget this user's. */
export async function releaseSavedCopies(): Promise<void> {
  const previous = currentSavedCopyStore();
  boundUserId = null;
  setSavedCopyStore(null);
  if (previous) await previous.clear().catch(() => undefined);
}
