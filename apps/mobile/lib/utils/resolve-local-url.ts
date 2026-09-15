import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { pickDevHost } from './dev-host';

/**
 * On native, `localhost` / `127.0.0.1` point at the device, not the host
 * machine running the local stack. Remap them to a host the device can reach,
 * in this order (see `pickDevHost`):
 * 1. `EXPO_PUBLIC_DEV_HOST`, an explicit override;
 * 2. the Metro host this JS bundle was loaded from (`expoConfig.hostUri`,
 *    e.g. `192.168.0.126:8081`). A phone in Expo Go already reached the Mac
 *    at that address, so the API and Supabase are reachable there too;
 * 3. `localhost` on iOS (simulator), `10.0.2.2` on Android (emulator bridge).
 * Web keeps `localhost`. Release builds have no Metro host and no local URLs.
 */
export function resolveLocalUrl(url: string): string {
  if (!url || Platform.OS === 'web') return url;
  if (!url.includes('localhost') && !url.includes('127.0.0.1')) return url;

  const devHost = pickDevHost({
    envHost: process.env.EXPO_PUBLIC_DEV_HOST,
    metroHostUri: Constants.expoConfig?.hostUri,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
  });

  return url.replace('localhost', devHost).replace('127.0.0.1', devHost);
}
