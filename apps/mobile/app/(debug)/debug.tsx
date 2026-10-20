/**
 * /debug — dev builds only. What this build detects (platform, native
 * modules, Liquid Glass, accessibility settings) plus the glass surfaces and
 * toasts to try, and links to the other debug screens.
 *
 * Open: the project home's "Debug" button, `kortix://debug` (dev client), or
 * `exp://<metro-host>:8081/--/debug` (Expo Go). The route needs a signed-in user.
 *
 * Production: Metro inlines `__DEV__` as `false` and drops the `require` below, so the screen never
 * enters a release bundle; the route redirects to `/`.
 */

import { Redirect, Stack } from 'expo-router';
import type { ComponentType } from 'react';

const DebugScreen: ComponentType | null = __DEV__
  ? (require('@/components/debug/DebugScreen') as typeof import('@/components/debug/DebugScreen')).DebugScreen
  : null;

export default function DebugRoute() {
  if (!DebugScreen) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <DebugScreen />
    </>
  );
}
