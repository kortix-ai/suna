/**
 * Who may create an account on a self-hosted instance by signing up.
 *
 * The auth service (GoTrue) asks the Postgres function
 * kortix.before_user_created_hook before it creates a user from a sign-up, a
 * magic link, an OAuth or SAML sign-in, or an invite. kortix-api writes the
 * policy that function reads from KORTIX_SIGNUP_MODE (set in kortix-api's
 * Compose environment from signupModeOf) and KORTIX_PLATFORM_ADMIN_EMAILS:
 *
 * - An SSO (SAML) sign-in always passes. Only DISABLE_SIGNUP stops it.
 * - An operator address (KORTIX_PLATFORM_ADMIN_EMAILS) can never be claimed by
 *   signing up. `kortix self-host admin add <email>` creates that account.
 * - `open`: anyone else may sign up. `invite`: only an address with a pending
 *   account invitation. `closed`: nobody.
 */
import { reachabilityMode } from './tunnel';

export type SignupMode = 'open' | 'invite' | 'closed';

export const SIGNUP_MODES: readonly SignupMode[] = ['open', 'invite', 'closed'];

type SignupEnv = Record<string, string | undefined>;

export function isSignupMode(value: string | undefined): value is SignupMode {
  return (SIGNUP_MODES as readonly string[]).includes(value?.trim() ?? '');
}

/**
 * The effective sign-up mode. An explicit KORTIX_SIGNUP_MODE wins. Otherwise a
 * laptop instance, and an instance that confirms email addresses (EMAIL_URL
 * set, so ENABLE_EMAIL_AUTOCONFIRM=false), stay `open`. An instance on a public
 * domain or tunnel that confirms nothing gets `invite`: without that, anyone
 * who reaches it can create a confirmed account for any address.
 */
export function signupModeOf(env: SignupEnv): SignupMode {
  const explicit = env.KORTIX_SIGNUP_MODE?.trim();
  if (isSignupMode(explicit)) return explicit;
  if (reachabilityMode(env) === 'local') return 'open';
  const autoconfirm = (env.ENABLE_EMAIL_AUTOCONFIRM ?? 'true').trim() === 'true';
  return autoconfirm ? 'invite' : 'open';
}
