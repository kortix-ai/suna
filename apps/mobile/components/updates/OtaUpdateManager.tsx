/**
 * Over-the-air update handling. Renders nothing.
 *
 * - Launch: the native module checks on load (`checkAutomatically: "ON_LOAD"`,
 *   launch wait 0 ms), so launch never waits on the network. A found update
 *   downloads in the background.
 * - Foreground: checks again at most once every 6 hours and downloads silently.
 * - A downloaded update applies on the next cold start. The running app is
 *   never reloaded: a reload mid-session reads to the user as a crash.
 *
 * `Updates.useUpdates()` re-renders on every native state change, so it lives
 * in this leaf instead of the root layout.
 */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { log } from '@/lib/logger';

const FOREGROUND_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function OtaUpdateManager() {
  const { isUpdateAvailable, isUpdatePending, isDownloading } = Updates.useUpdates();
  const isChecking = useRef(false);
  // The native launch check counts as the first check.
  const lastCheckAt = useRef(Date.now());

  // The launch check found an update the native module has not fetched yet.
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;
    if (!isUpdateAvailable || isDownloading || isUpdatePending) return;
    // A foreground check that found this update is already fetching it.
    if (isChecking.current) return;
    Updates.fetchUpdateAsync().catch((error) => {
      log.error('❌ OTA: Failed to fetch update:', error);
    });
  }, [isUpdateAvailable, isDownloading, isUpdatePending]);

  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    const checkInBackground = async () => {
      if (isChecking.current) return;
      if (Date.now() - lastCheckAt.current < FOREGROUND_CHECK_INTERVAL_MS) return;
      isChecking.current = true;
      lastCheckAt.current = Date.now();
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          log.log('✅ OTA: Update downloaded; applies on next launch');
        }
      } catch (error) {
        log.error('❌ OTA: Foreground check failed:', error);
      } finally {
        isChecking.current = false;
      }
    };

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkInBackground();
    });
    return () => subscription.remove();
  }, []);

  return null;
}
