import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { useSegments } from 'expo-router';
import { API_URL, getAuthHeaders } from '@/api/config';
import { useAuthContext } from '@/contexts';

const HEARTBEAT_INTERVAL = 30000;

export function usePresence(threadId: string | null | undefined) {
  const { isAuthenticated, user } = useAuthContext();
  const segments = useSegments();
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef(AppState.currentState);

  const updatePresence = async (activeThreadId: string | null) => {
    if (!isAuthenticated || !user) return;

    const timestamp = new Date().toISOString();

    try {
      const headers = await getAuthHeaders();
      await fetch(`${API_URL}/presence/update`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          active_thread_id: activeThreadId,
          platform: Platform.OS,
          client_timestamp: timestamp,
        }),
      });
    } catch (error) {}
  };

  const stopHeartbeat = () => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  };

  const startHeartbeat = (activeThreadId: string) => {
    stopHeartbeat();
    heartbeatRef.current = setInterval(() => {
      updatePresence(activeThreadId);
    }, HEARTBEAT_INTERVAL);
  };

  useEffect(() => {
    if (!isAuthenticated) {
      stopHeartbeat();
      return;
    }

    const currentThread = threadId || null;

    stopHeartbeat();
    updatePresence(currentThread);

    if (currentThread) {
      startHeartbeat(currentThread);
    }

    return () => {
      stopHeartbeat();
    };
  }, [segments, threadId, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const currentThread = threadId || null;

      if (nextAppState === 'active' && appStateRef.current.match(/inactive|background/)) {
        updatePresence(currentThread);
        if (currentThread) {
          startHeartbeat(currentThread);
        }
      } else if (nextAppState === 'inactive' || nextAppState === 'background') {
        stopHeartbeat();
        updatePresence(null);
      }

      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
      stopHeartbeat();
    };
  }, [isAuthenticated, threadId]);
}
