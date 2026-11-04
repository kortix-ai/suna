import { selfHostSignupPolicy } from '@kortix/db';
import { config } from '../config';
import { db, hasDatabase } from './db';
import { selfHostOperatorAllowlist } from './self-host-operator';

/**
 * Writes the self-host sign-up policy that the auth service's
 * before-user-created hook reads (kortix.before_user_created_hook, migration
 * 20261104155306917). Each API process writes it at boot, so `kortix self-host
 * env set KORTIX_SIGNUP_MODE=…` or a changed KORTIX_PLATFORM_ADMIN_EMAILS takes
 * effect with the API roll. The operator addresses are reserved: nobody can
 * claim one by signing up, so an allowlisted address without an account can no
 * longer be taken over on an instance without email confirmation.
 *
 * Returns false when there is nothing to write: KORTIX_SIGNUP_MODE unset (Kortix
 * cloud) or no database.
 */
export async function syncSelfHostSignupPolicy(): Promise<boolean> {
  const signupMode = config.KORTIX_SIGNUP_MODE;
  if (!signupMode || !hasDatabase) return false;
  const reservedEmails = selfHostOperatorAllowlist();
  await db
    .insert(selfHostSignupPolicy)
    .values({ id: true, signupMode, reservedEmails, updatedAt: new Date() })
    .onConflictDoUpdate({ target: selfHostSignupPolicy.id, set: { signupMode, reservedEmails, updatedAt: new Date() } });
  return true;
}
