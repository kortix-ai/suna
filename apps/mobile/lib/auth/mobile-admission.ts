import type { Session, User } from '@supabase/supabase-js';

import { consumeWebRegistrationHandoff } from './callback-state.ts';

export const NEW_USER_REJECTION_WINDOW_MS = 30_000;

/**
 * Mobile is login-only. A user whose account was created moments ago as part of
 * a direct mobile OAuth flow must not be allowed in — registration only happens
 * on the web. Password sign-up is web-only and magic link uses
 * `shouldCreateUser: false`, so OAuth is the only path that can mint a new user.
 */
export function isNewlyCreatedUser(
  user: Pick<User, 'created_at'>,
  now = Date.now(),
): boolean {
  const created = user.created_at ? new Date(user.created_at).getTime() : 0;
  if (!created) return false;
  return now - created < NEW_USER_REJECTION_WINDOW_MS;
}

/**
 * Gate direct mobile OAuth sign-up. Existing accounts and verified web
 * registration handoffs are admitted even inside the rejection window.
 */
export function canAdmitMobileOAuthSession(
  user: Pick<User, 'created_at'> | null | undefined,
  options: { webRegistrationHandoffGranted: boolean; now?: number },
): boolean {
  if (!user) return true;
  return !isNewlyCreatedUser(user, options.now) || options.webRegistrationHandoffGranted;
}

export async function admitMobileOAuthSession(session: Session | null): Promise<boolean> {
  if (!session?.user) return true;
  const webRegistrationHandoffGranted = await consumeWebRegistrationHandoff();
  return canAdmitMobileOAuthSession(session.user, { webRegistrationHandoffGranted });
}
