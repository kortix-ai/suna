/**
 * The account requires single sign-on and the API refused this session with
 * 403 `sso_required` (KRTX-1716, lib/auth/sso-required): sign out once,
 * however many calls were refused, then open the SSO form with the user's
 * email. A refusal that arrives after a sign-out changes nothing. Mounted once
 * in `app/_layout.tsx`, after `AuthProtection`.
 *
 * The SSO form opens in the commit where the sign-out lands. `AuthProtection`
 * sends the same commit to `/auth`. It sits earlier in the tree, so its effect
 * runs first and this replace wins. Before the sign-out lands, the auth layout
 * would send a signed-in user on the form back to `/`.
 */

import * as React from 'react';
import { useRouter } from 'expo-router';

import { useAuthContext } from '@/contexts';
import { useSsoRequiredStore } from '@/lib/auth/sso-required';
import { log } from '@/lib/logger';

export function SsoRequiredSignOut() {
  const router = useRouter();
  const { user, isAuthenticated, signOut } = useAuthContext();
  const reported = useSsoRequiredStore((s) => s.reported);
  // The signed-out user's email while the sign-out runs, else null.
  const [email, setEmail] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!reported) return;
    useSsoRequiredStore.setState({ reported: false });
    if (!isAuthenticated || email !== null) return;
    setEmail(user?.email ?? '');
    log.warn('🔒 The account requires single sign-on; signing out');
    void signOut();
  }, [reported, isAuthenticated, email, user, signOut]);

  React.useEffect(() => {
    if (email === null || isAuthenticated) return;
    setEmail(null);
    router.replace({ pathname: '/auth/email', params: { reason: 'sso_required', email } });
  }, [email, isAuthenticated, router]);

  return null;
}
