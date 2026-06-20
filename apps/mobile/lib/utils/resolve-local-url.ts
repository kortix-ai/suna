import { Platform } from 'react-native';

/**
 * On native, `localhost` / `127.0.0.1` point at the device, not the host
 * machine running the local stack. Remap to the Android emulator bridge
 * (`10.0.2.2`) or an explicit `EXPO_PUBLIC_DEV_HOST` (a LAN IP for physical
 * devices). The iOS simulator and web can reach `localhost` directly.
 */
export function resolveLocalUrl(url: string): string {
  if (!url || Platform.OS === 'web') return url;
  if (!url.includes('localhost') && !url.includes('127.0.0.1')) return url;

  const devHost =
    process.env.EXPO_PUBLIC_DEV_HOST || (Platform.OS === 'ios' ? 'localhost' : '10.0.2.2');

  return url.replace('localhost', devHost).replace('127.0.0.1', devHost);
}
