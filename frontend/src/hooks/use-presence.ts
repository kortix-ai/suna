import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { backendApi } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';

const HEARTBEAT_INTERVAL = 30000;
const API_URL = process.env.NEXT_PUBLIC_API_URL;

export function usePresence(threadId: string | null | undefined) {
  const { user } = useAuth();
  const isAuthenticated = !!user;
  const pathname = usePathname();
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const updatePresence = async (activeThreadId: string | null) => {
    if (!isAuthenticated) return;
    const timestamp = new Date().toISOString();
    try {
      await backendApi.post('/presence/update', {
        active_thread_id: activeThreadId,
        platform: 'web',
        client_timestamp: timestamp,
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
  }, [pathname, threadId, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const handleVisibilityChange = () => {
      const currentThread = threadId || null;
      
      if (document.hidden) {
        stopHeartbeat();
        updatePresence(null);
      } else {
        updatePresence(currentThread);
        if (currentThread) {
          startHeartbeat(currentThread);
        }
      }
    };

    const handleBeforeUnload = () => {
      navigator.sendBeacon?.(
        `${API_URL}/presence/clear`,
        new Blob([JSON.stringify({})], { type: 'application/json' })
      );
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isAuthenticated, threadId]);
}
