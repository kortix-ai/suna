/**
 * "Your session has ended" (COR-144): the one dialog for an expired login.
 * `lib/auth/session-expiry-monitor.ts` decides when the login is really gone
 * (a Supabase refresh that fails for good, or a `SIGNED_OUT` no sign-out asked
 * for); this component only shows it. Mounted once in `app/_layout.tsx`.
 *
 * One action, no Cancel: the app cannot work without a login. "Sign in again"
 * runs the normal sign-out (clears the per-user caches and storage) and opens
 * `/auth`. The copy is the start screen's (`startFailureCopy('session')`).
 */

import * as React from 'react';
import { useRouter } from 'expo-router';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { useSessionExpiryStore } from '@/lib/auth/session-expiry';
import { installSessionExpiryListener, sessionExpiry } from '@/lib/auth/session-expiry-monitor';
import { startFailureCopy } from '@/lib/projects/start-failure';
import { OVERLAY_PORTAL_HOST } from '@/lib/ui/portal-hosts';

export function SessionEndedDialog() {
  const router = useRouter();
  const { isAuthenticated, signOut } = useAuthContext();
  const expired = useSessionExpiryStore((state) => state.phase === 'expired');
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => installSessionExpiryListener(), []);

  // A signed-in user arms the monitor; a new sign-in clears an old expiry.
  // Signing out never disarms from here: the unrequested `SIGNED_OUT` must
  // still reach an armed monitor. Deliberate sign-outs disarm themselves.
  React.useEffect(() => {
    if (isAuthenticated) sessionExpiry.arm();
  }, [isAuthenticated]);

  const handleSignInAgain = React.useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    // `signOut` disarms the monitor, which closes this dialog.
    await signOut().catch(() => null);
    sessionExpiry.disarm();
    setSigningOut(false);
    router.replace('/auth');
  }, [router, signOut, signingOut]);

  const copy = startFailureCopy('session');

  return (
    <AlertDialog open={expired}>
      <AlertDialogContent className="rounded-3xl" portalHost={OVERLAY_PORTAL_HOST}>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            size="lg"
            className="rounded-full"
            disabled={signingOut}
            onPress={handleSignInAgain}>
            <Text>Sign in again</Text>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
