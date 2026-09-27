/**
 * openFileOnDevice — hands a downloaded file to the device, which opens it in
 * its own app. Never the share sheet, never an in-app viewer (Jay, 2026-09-22).
 *
 * - Android: a view intent on a content URI of the file, with the read grant
 *   (`expo-intent-launcher` + `getContentUriAsync`). The device starts its PDF,
 *   slides, sheet or text app. Part of the Expo SDK, so it works in Expo Go too.
 * - iOS: Quick Look (`@react-native-documents/viewer`). A custom native module:
 *   a development or store build has it, Expo Go does not.
 *
 * OTA safety: `runtimeVersion` is a fixed string, so an OTA update can reach a
 * binary built before either module. Both packages resolve their native module
 * at import and throw when it is missing, so each is required only when its
 * module is in the running binary; otherwise the result is `'unavailable'`.
 */
import { Platform, TurboModuleRegistry } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import * as FileSystem from 'expo-file-system/legacy';

import { mimeTypeForFile } from './mime-type';
import { isNoAppError } from './no-app-error';

export type OpenOnDeviceResult =
  /** The device's app is showing the file. */
  | 'opened'
  /** No app on the device opens this file type. */
  | 'no-app'
  /** This binary has no module that can open a file (iOS in Expo Go, an old build). */
  | 'unavailable';

/** `Intent.FLAG_GRANT_READ_URI_PERMISSION`: the receiving app may read the content URI. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

async function openOnAndroid(uri: string, name: string): Promise<OpenOnDeviceResult> {
  if (requireOptionalNativeModule('ExpoIntentLauncher') == null) return 'unavailable';
  const IntentLauncher = require('expo-intent-launcher') as typeof import('expo-intent-launcher');
  // A `file://` URI cannot leave the app; the content URI can, with the read grant.
  const contentUri = await FileSystem.getContentUriAsync(uri);
  // Resolves when the user comes back from the other app, so it is not awaited:
  // the caller's button must not stay busy meanwhile. A missing app rejects at once.
  const launched = IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
    type: mimeTypeForFile(name) ?? '*/*',
  });
  const failure = await Promise.race([
    launched.then(() => null).catch((error: unknown) => error),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
  ]);
  if (failure == null) return 'opened';
  if (isNoAppError(failure)) return 'no-app';
  throw failure;
}

async function openOnIos(uri: string, name: string): Promise<OpenOnDeviceResult> {
  if (TurboModuleRegistry.get('RNDocumentViewer') == null) return 'unavailable';
  const { viewDocument } =
    require('@react-native-documents/viewer') as typeof import('@react-native-documents/viewer');
  try {
    await viewDocument({ uri, mimeType: mimeTypeForFile(name), headerTitle: name });
    return 'opened';
  } catch (error) {
    if (isNoAppError(error)) return 'no-app';
    throw error;
  }
}

export function openFileOnDevice(uri: string, name: string): Promise<OpenOnDeviceResult> {
  return Platform.OS === 'android' ? openOnAndroid(uri, name) : openOnIos(uri, name);
}
