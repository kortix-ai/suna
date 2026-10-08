/**
 * Ends the login on this device only (scope `local`). The default scope
 * `global` revokes every session of the user: web and every other install
 * then fail their next refresh and are signed out too.
 *
 * Never throws. Returns the error (or null) so the caller can log it. auth-js
 * removes the stored session even when the logout call fails, but not when
 * it cannot load the session first (an expired token whose refresh fails).
 * Callers that must leave no session behind also clear storage.
 */
export async function signOutThisDevice(auth: {
  signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
}): Promise<unknown> {
  try {
    return (await auth.signOut({ scope: 'local' })).error ?? null;
  } catch (error) {
    return error;
  }
}
