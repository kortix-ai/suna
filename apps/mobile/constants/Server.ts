import { Platform } from 'react-native';

const DEFAULT_BACKEND_URL = 'http://localhost:8000/api';
const configuredBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL;

const resolveBackendHost = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();

    const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1';
    if (!isLoopbackHost) {
      return rawUrl;
    }

    if (Platform.OS === 'android') {
      // Android emulators expose the host loopback on 10.0.2.2
      url.hostname = '10.0.2.2';
      return url.toString();
    }

    if (Platform.OS === 'ios') {
      // iOS simulator can talk to 127.0.0.1, ensure we use it explicitly
      url.hostname = '127.0.0.1';
      return url.toString();
    }

    console.warn(
      'The mobile app is running on a physical device; update EXPO_PUBLIC_BACKEND_URL to a reachable LAN IP.'
    );
    return rawUrl;
  } catch (error) {
    console.warn('Failed to parse backend URL, falling back to default:', error);
    return DEFAULT_BACKEND_URL;
  }
};

export const SERVER_URL = resolveBackendHost(configuredBackendUrl);
