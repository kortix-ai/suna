/**
 * The saved deployment choice, read synchronously at startup.
 *
 * Every endpoint (API URL, Supabase client, SDK `configureKortix`, web links)
 * is fixed when its module first loads, so the choice must be known before any
 * of them does. expo-file-system reads synchronously; AsyncStorage cannot.
 * A change is applied by reloading the JS bundle, so no module, cache or
 * subscription from the previous deployment survives.
 */

import { parseSavedDeployment, type Deployment } from './deployment';

const FILE_NAME = 'kortix-deployment.json';

function deploymentFile() {
  // Lazy: the native module is absent under bun, where this returns the default.
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  return new File(Paths.document, FILE_NAME);
}

function readSavedDeployment(): Deployment | null {
  try {
    // This can run before api/supabase.ts installs the URL polyfill, and the
    // parser needs a full URL (hostname, origin). Loading it twice is a no-op.
    require('react-native-url-polyfill/auto');
    const file = deploymentFile();
    return file.exists ? parseSavedDeployment(file.textSync()) : null;
  } catch {
    return null;
  }
}

/** The deployment this JS run uses; null = the build's configured Kortix (cloud). */
export const activeDeployment: Deployment | null = readSavedDeployment();

/** Persist the choice. It takes effect on the next bundle load (`reloadApp`). */
export function saveDeployment(deployment: Deployment | null): void {
  const file = deploymentFile();
  if (!deployment) {
    if (file.exists) file.delete();
    return;
  }
  if (!file.exists) file.create();
  file.write(JSON.stringify(deployment));
}
