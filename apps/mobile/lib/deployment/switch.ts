import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { DevSettings } from 'react-native';

import { supabase } from '@/api/supabase';
import { sessionExpiry } from '@/lib/auth/session-expiry-monitor';
import { signOutThisDevice } from '@/lib/auth/sign-out';
import { keysToClear } from '@/lib/auth/sign-out-keys';
import { log } from '@/lib/logger';

import type { Deployment } from './deployment';
import { saveDeployment } from './store';

/**
 * Point the app at another deployment (null = the build's Kortix). Signs out
 * locally, clears every account-scoped key (the same set sign-out clears), then
 * reloads the JS bundle so the API URL, Supabase client, SDK config and query
 * cache all start over on the new deployment. Nothing crosses deployments.
 *
 * Resolves false when the app could not reload itself: the choice is saved and
 * applies on the next launch.
 */
export async function switchDeployment(deployment: Deployment | null): Promise<boolean> {
  sessionExpiry.disarm();
  await signOutThisDevice(supabase.auth);
  try {
    await AsyncStorage.multiRemove(keysToClear(await AsyncStorage.getAllKeys()));
  } catch (error) {
    log.warn('⚠️ Could not clear storage before switching deployment:', error);
  }
  saveDeployment(deployment);
  try {
    if (__DEV__) DevSettings.reload();
    else await Updates.reloadAsync();
    return true;
  } catch (error) {
    log.warn('⚠️ Reload after switching deployment failed:', error);
    return false;
  }
}
