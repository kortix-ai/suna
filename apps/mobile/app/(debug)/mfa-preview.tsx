/**
 * /mfa-preview — dev builds only. The TOTP step-up screen outside the auth
 * gates, with a fake verify (`000000` passes), so its focus and keyboard
 * behaviour can be checked while signed in. Open it from the Debug page.
 *
 * Production: Metro inlines `__DEV__` as `false`; the route redirects to `/`.
 */

import { Redirect } from 'expo-router';

import { MfaScreen } from '@/components/auth/MfaScreen';

export default function MfaPreviewRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <MfaScreen preview />;
}
