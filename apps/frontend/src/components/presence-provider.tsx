'use client';

import { backendApi } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase/client';
import { RealtimeChannel } from '@supabase/supabase-js';
import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

type PresenceStatus = 'online' | 'idle' | 'offline';
type PresenceEventPayload = {
  type: string;
  session_id?: string;
  account_id: string;
  active_thread_id: string | null;
  platform?: string;
  status?: PresenceStatus;
  last_seen?: string;
  client_timestamp?: string;
};

type PresenceContextValue = {
  activeThreadId: string | null;
  setActiveThreadId: (threadId: string | null) => void;
  connectionState: 'idle' | 'connecting' | 'connected' | 'error';
  presences: Record<string, PresenceEventPayload>;
  sessionId: string | null;
};

const PresenceContext = createContext<PresenceContextValue | undefined>(undefined);

const HEARTBEAT_INTERVAL = 60000;
const DEBOUNCE_DELAY = 500;

const DISABLE_PRESENCE = true;

function generateSessionId(): string {
  // Use crypto.randomUUID if available, otherwise fallback to a custom implementation
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  // Fallback UUID v4 implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user, session } = useAuth();
  const [activeThreadId, setActiveThreadState] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [presences, setPresences] = useState<Record<string, PresenceEventPayload>>({});
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    
    let storedId = sessionStorage.getItem('presence_session_id');
    if (!storedId) {
      storedId = generateSessionId();
      sessionStorage.setItem('presence_session_id', storedId);
    } else {
    }
    return storedId;
  });
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const latestThreadRef = useRef<string | null>(null);
  const pendingRequestRef = useRef<Promise<void> | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSentThreadRef = useRef<string | null>(null);
  const hasInitializedRef = useRef<boolean>(false);
  const lastUpdateTimeRef = useRef<number>(0);
  const MIN_UPDATE_INTERVAL = 2000; // Minimum 2 seconds between updates

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const sendPresenceUpdate = useCallback(
    async (threadId: string | null, force: boolean = false) => {
      if (DISABLE_PRESENCE || !user || !sessionId) {
        return;
      }

      const threadKey = threadId || 'null';
      const now = Date.now();

      if (!force && now - lastUpdateTimeRef.current < MIN_UPDATE_INTERVAL) {
        console.log('[Presence] Rate limited - skipping update');
        return;
      }

      if (!force && lastSentThreadRef.current === threadKey && pendingRequestRef.current) {
        console.log('[Presence] Duplicate call prevented for same thread:', threadKey);
        return;
      }

      if (pendingRequestRef.current) {
        try {
          await pendingRequestRef.current;
        } catch {
        }
      }

      const timestamp = new Date().toISOString();
      lastSentThreadRef.current = threadKey;
      lastUpdateTimeRef.current = now;

      const requestPromise = (async () => {
        try {
          console.log('[Presence] Sending update:', { threadId, sessionId: sessionId.slice(0, 8) });
          await backendApi.post('/presence/update', {
            session_id: sessionId,
            active_thread_id: threadId,
            platform: 'web',
            client_timestamp: timestamp,
          }, { showErrors: false });
        } catch (err) {
          console.error('[Presence] Update failed:', err);
          throw err;
        } finally {
          setTimeout(() => {
            if (pendingRequestRef.current === requestPromise) {
              pendingRequestRef.current = null;
            }
          }, 100);
        }
      })();

      pendingRequestRef.current = requestPromise;
      return requestPromise;
    },
    [user, sessionId],
  );

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    if (!user) {
      return;
    }
    heartbeatRef.current = setInterval(() => {
      sendPresenceUpdate(latestThreadRef.current);
    }, HEARTBEAT_INTERVAL);
  }, [sendPresenceUpdate, stopHeartbeat, user]);

  const disconnectChannel = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  const handlePresenceChange = useCallback((payload: any) => {
    if (!payload.new) {
      return;
    }
    
    const record = payload.new as {
      session_id: string;
      account_id: string;
      active_thread_id: string | null;
      platform: string;
      last_seen: string;
      client_timestamp: string;
    };

    if (!record.account_id) {
      return;
    }

    const presencePayload: PresenceEventPayload = {
      type: payload.eventType === 'DELETE' ? 'presence_clear' : 'presence_update',
      session_id: record.session_id,
      account_id: record.account_id,
      active_thread_id: record.active_thread_id,
      platform: record.platform,
      status: record.active_thread_id ? 'online' : 'idle',
      last_seen: record.last_seen,
      client_timestamp: record.client_timestamp,
    };

    setPresences((prev) => {
      const key = `${record.account_id}:${record.session_id}`;
      
      if (payload.eventType === 'DELETE' || !record.active_thread_id) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      
      return {
        ...prev,
        [key]: presencePayload,
      };
    });
  }, []);

  const handlePresenceDelete = useCallback((payload: any) => {
    if (!payload.old) {
      return;
    }

    const record = payload.old as {
      session_id: string;
      account_id: string;
    };

    setPresences((prev) => {
      const key = `${record.account_id}:${record.session_id}`;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const connectChannel = useCallback(() => {
    if (DISABLE_PRESENCE || !user) {
      return;
    }
    
    if (channelRef.current) {
      return;
    }

    setConnectionState('connecting');

    const supabase = createClient();
    const channel = supabase
      .channel('presence-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_presence_sessions',
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            handlePresenceDelete(payload);
          } else {
            handlePresenceChange(payload);
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setConnectionState('connected');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setConnectionState('error');
        } else if (status === 'CLOSED') {
          setConnectionState('idle');
        }
      });

    channelRef.current = channel;
  }, [user, handlePresenceChange, handlePresenceDelete]);

  const sendBeaconClear = useCallback(() => {
    if (DISABLE_PRESENCE || typeof navigator === 'undefined' || !sessionId) {
      return;
    }
    const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    if (!apiUrl || !session?.access_token) {
      return;
    }
    const url = new URL(`${apiUrl}/presence/clear`);
    url.searchParams.set('token', session.access_token);
    url.searchParams.set('session_id', sessionId);
    
    const payload = new Blob([JSON.stringify({})], { type: 'application/json' });
    navigator.sendBeacon(url.toString(), payload);
    
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('presence_session_id');
    }
  }, [session?.access_token, sessionId]);

  const setActiveThreadId = useCallback((threadId: string | null) => {
    const normalized = threadId || null;
    
    if (latestThreadRef.current === normalized) {
      return;
    }
    
    latestThreadRef.current = normalized;
    setActiveThreadState(normalized);
    
    if (DISABLE_PRESENCE || !user) {
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      sendPresenceUpdate(normalized, true);
      startHeartbeat();
    }, DEBOUNCE_DELAY);
  }, [sendPresenceUpdate, startHeartbeat, user]);

  useEffect(() => {
    if (DISABLE_PRESENCE || !user) {
      stopHeartbeat();
      disconnectChannel();
      setConnectionState('idle');
      setPresences({});
      latestThreadRef.current = null;
      setActiveThreadState(null);
      lastSentThreadRef.current = null;
      hasInitializedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      return;
    }
    
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      sendPresenceUpdate(latestThreadRef.current, true);
    }
    
    startHeartbeat();
    connectChannel();
    
    return () => {
      stopHeartbeat();
      disconnectChannel();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [connectChannel, disconnectChannel, sendPresenceUpdate, startHeartbeat, stopHeartbeat, user]);

  useEffect(() => {
    if (DISABLE_PRESENCE || typeof document === 'undefined') {
      return;
    }
    
    let wasHidden = document.hidden;
    
    const handleVisibilityChange = () => {
      if (!user) {
        return;
      }
      
      if (wasHidden === document.hidden) {
        return;
      }
      
      wasHidden = document.hidden;
      
      if (document.hidden) {
        stopHeartbeat();
        sendPresenceUpdate(null, false);
      } else {
        if (hasInitializedRef.current) {
          sendPresenceUpdate(latestThreadRef.current, false);
        }
        startHeartbeat();
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [sendPresenceUpdate, startHeartbeat, stopHeartbeat, user]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handler = () => {
      sendBeaconClear();
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
    };
  }, [sendBeaconClear]);

  const value = useMemo(() => ({
    activeThreadId,
    setActiveThreadId,
    connectionState,
    presences,
    sessionId,
  }), [activeThreadId, connectionState, presences, setActiveThreadId, sessionId]);

  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresenceContext() {
  const context = useContext(PresenceContext);
  if (!context) {
    throw new Error('usePresenceContext must be used within PresenceProvider');
  }
  return context;
}
