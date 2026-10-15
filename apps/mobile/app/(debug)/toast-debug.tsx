/**
 * /toast-debug — dev builds only. Every toast the app shows, one tap each, as
 * the web page `/debug/toast`.
 *
 * Open: the project home's "Debug toasts" button, `kortix://toast-debug` (dev
 * client), or `exp://<metro-host>:8081/--/toast-debug` (Expo Go).
 *
 * Production: Metro inlines `__DEV__` as `false` and drops the `require` below,
 * so the screen never enters a release bundle; the route redirects to `/`.
 */

import { Redirect, Stack } from 'expo-router';
import type { ComponentType } from 'react';

const ToastDebugScreen: ComponentType | null = __DEV__
  ? (require('@/components/debug/ToastDebugScreen') as typeof import('@/components/debug/ToastDebugScreen')).ToastDebugScreen
  : null;

export default function ToastDebugRoute() {
  if (!ToastDebugScreen) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ToastDebugScreen />
    </>
  );
}
