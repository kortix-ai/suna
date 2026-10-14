/**
 * /genui-debug — dev builds only. Every generative UI block through the mobile renderer, with the
 * same samples as the web page `/debug/genui` (`@kortix/shared/genui-samples`).
 *
 * Open: the project home's "Debug GenUI" button, `kortix://genui-debug` (dev client), or
 * `exp://<metro-host>:8081/--/genui-debug` (Expo Go). The route needs a signed-in user.
 *
 * Production: Metro inlines `__DEV__` as `false` and drops the `require` below, so the screen and the
 * samples never enter a release bundle; the route redirects to `/`.
 */

import { Redirect, Stack } from 'expo-router';
import type { ComponentType } from 'react';

const GenuiDebugScreen: ComponentType | null = __DEV__
  ? (require('@/components/debug/GenuiDebugScreen') as typeof import('@/components/debug/GenuiDebugScreen')).GenuiDebugScreen
  : null;

export default function GenuiDebugRoute() {
  if (!GenuiDebugScreen) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <GenuiDebugScreen />
    </>
  );
}
