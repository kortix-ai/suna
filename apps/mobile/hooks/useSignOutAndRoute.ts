import * as React from 'react';
import { useRouter } from 'expo-router';
import { useAuthContext } from '@/contexts';

/**
 * The "sign out, then land on the auth screen" dance shared by every signed-in
 * surface that offers sign-out (the boot screen, `/new`, MFA, the invite
 * screen): a double tap does nothing, a failed sign-out (auth server down)
 * leaves the screen usable, and a successful one replaces the stack with
 * `/auth`. Returns `signingOut` for the button's disabled/busy state and the
 * boolean outcome, so a surface with extra bookkeeping (the invite link) can
 * react to the failure it owns.
 */
export function useSignOutAndRoute() {
  const { signOut } = useAuthContext();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);
  const signOutAndRoute = React.useCallback(async (): Promise<boolean> => {
    if (signingOut) return false;
    setSigningOut(true);
    const result = await signOut().catch(() => null);
    setSigningOut(false);
    const signedOut = result?.success === true;
    if (signedOut) router.replace('/auth');
    return signedOut;
  }, [router, signOut, signingOut]);
  return { signingOut, signOutAndRoute };
}
