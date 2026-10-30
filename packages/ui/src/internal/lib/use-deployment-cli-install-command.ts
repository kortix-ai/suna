'use client';

import { useSyncExternalStore } from 'react';

import { getDeploymentCliInstallCommand } from './kortix-cli';

const subscribeToOrigin = () => () => {};
const getBrowserOrigin = () => window.location.origin;
const getServerOrigin = () => '';

/**
 * Returns the current deployment's CLI installer command without changing the
 * server and first browser render. React reads the browser origin after
 * hydration and updates the command once.
 */
export function useDeploymentCliInstallCommand(version: string | undefined): string {
  const origin = useSyncExternalStore(subscribeToOrigin, getBrowserOrigin, getServerOrigin);
  return getDeploymentCliInstallCommand(version, origin);
}
