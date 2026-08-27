'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { registerAppRouter } from './router-bridge';

/**
 * Publishes the App Router instance to `router-bridge.ts` so non-component
 * modules (stores, error handlers, the notification callback) can navigate
 * without a full page reload. Mounted once, in the root layout.
 *
 * Registration happens in an effect, not during render: writing module state
 * while rendering is a side effect React may discard or replay.
 */
export function RouterBridge() {
  const router = useRouter();
  useEffect(() => {
    registerAppRouter(router);
    return () => registerAppRouter(null);
  }, [router]);
  return null;
}
