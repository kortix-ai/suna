/**
 * Write the signed-in user's profile metadata through `@kortix/sdk`.
 *
 * The replacement for `supabase.auth.updateUser({ data })`. Every caller that
 * only ever wrote metadata — display name, avatar URL, locale — can use this
 * and stop constructing a Supabase client, which is the first step of taking
 * `apps/web` off the Supabase SDK entirely.
 *
 * Deliberately NOT a general `updateUser`: password and email changes are
 * credential changes with their own flows, and the API refuses them on this
 * route (its schema is `.strict()`), so a caller cannot smuggle one through
 * here by accident.
 *
 * The access token still comes from `getSupabaseAccessToken` for now. That is
 * the intermediate state on purpose: the token SOURCE is the session cutover,
 * and moving it is atomic with the middleware and the auth provider — whoever
 * writes the session cookie owns auth, and two session sources disagreeing is
 * a logout that does not log out. Call sites move first; the source moves last.
 */

import { updateUserMetadata } from '@kortix/sdk';

import { getSupabaseAccessToken } from '@/lib/auth-token';

/** Thrown when there is no session to attribute the write to. */
export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in — no access token to update a profile with.');
    this.name = 'NotSignedInError';
  }
}

export async function updateProfileMetadata(data: Record<string, unknown>): Promise<void> {
  const token = await getSupabaseAccessToken();
  if (!token) throw new NotSignedInError();
  await updateUserMetadata({ data }, token);
}
