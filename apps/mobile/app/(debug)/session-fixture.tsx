/**
 * /session-fixture — dev builds only (COR-91).
 *
 * Renders the shared parity fixture (`@kortix/shared/session-fixture`) through
 * the real `SessionTurn` transcript, for side-by-side comparison with the web
 * page `/debug/session-fixture`.
 *
 * Open: `kortix://session-fixture` (dev client), or
 * `exp://<metro-host>:8081/--/session-fixture` (Expo Go). The route needs a
 * signed-in user: `AuthProtection` sends everyone else to /auth.
 *
 * Production: Metro inlines `__DEV__` as `false` and constant-folds the
 * ternary before it collects dependencies, so the `require` below — and the
 * fixture data behind it — never enter a release bundle. The route itself
 * then redirects to `/`.
 */

import { Redirect, Stack } from 'expo-router';
import type { ComponentType } from 'react';

const SessionFixtureScreen: ComponentType | null = __DEV__
  ? (require('@/components/debug/SessionFixtureScreen') as typeof import('@/components/debug/SessionFixtureScreen'))
      .SessionFixtureScreen
  : null;

export default function SessionFixtureRoute() {
  if (!SessionFixtureScreen) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SessionFixtureScreen />
    </>
  );
}
