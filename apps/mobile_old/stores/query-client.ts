import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import type { AppStateStatus } from 'react-native';
import { AppState, Platform } from 'react-native';

// Network status management
onlineManager.setEventListener(setOnline => {
  return NetInfo.addEventListener(state => {
    setOnline(!!state.isConnected);
  });
});

// App focus management
function onAppStateChange(status: AppStateStatus) {
  if (Platform.OS !== 'web') {
    focusManager.setFocused(status === 'active');
  }
}

// Initialize AppState listener
let appStateSubscription: any;

export const initializeAppState = () => {
  appStateSubscription = AppState.addEventListener('change', onAppStateChange);
};

export const cleanupAppState = () => {
  if (appStateSubscription) {
    appStateSubscription.remove();
  }
};

// Optimized Query Client
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Performance optimizations
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes - limited for streaming lists
      retry: 2,
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // Network mode for offline support
      networkMode: 'offlineFirst',
    },
    mutations: {
      retry: 1,
      networkMode: 'offlineFirst',
    },
  },
});

// Async storage persister for file manifests and rehydratable data
const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'SUNA_QUERY_CACHE',
  serialize: JSON.stringify,
  deserialize: JSON.parse,
});

// Persist query client with selective persistence
export const initializePersistence = async () => {
  await persistQueryClient({
    queryClient,
    persister: asyncStoragePersister,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    // Only persist specific query types
    dehydrateOptions: {
      shouldDehydrateQuery: (query) => {
        // Only persist file manifests and other rehydratable data
        const queryKey = query.queryKey[0] as string;
        return ['file-manifest', 'user-settings', 'app-config'].includes(queryKey);
      },
    },
  });
};

// Streaming query helper for chat
export const createStreamingQuery = <T>(
  queryKey: string[],
  queryFn: () => Promise<T>,
  sessionId?: string
) => ({
  queryKey: sessionId ? [...queryKey, sessionId] : queryKey,
  queryFn,
  // Reduced cache time for streaming lists to cut memory
  gcTime: 2 * 60 * 1000, // 2 minutes for streaming data
  staleTime: 0, // Always consider stale for real-time data
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
}); 