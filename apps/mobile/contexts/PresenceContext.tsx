import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL, getAuthToken } from '@/api/config';
import { useAuthContext } from '@/contexts/AuthContext';
import { supabase } from '@/api/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import { log } from '@/lib/logger';

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
const SESSION_STORAGE_KEY = 'presence_session_id';

const DISABLE_PRESENCE = true;

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuthContext();
  const [activeThreadId, setActiveThreadState] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [presences, setPresences] = useState<Record<string, PresenceEventPayload>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const latestThreadRef = useRef<string | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const pendingRequestRef = useRef<Promise<void> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentThreadRef = useRef<string | null>(null);

  useEffect(() => {
    async function loadSessionId() {
      try {
        let storedId = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
        if (!storedId) {
          storedId = generateSessionId();
          await AsyncStorage.setItem(SESSION_STORAGE_KEY, storedId);
        }
        setSessionId(storedId);
      } catch (error) {
        log.error('[Presence] Failed to load session ID:', error);
        const fallbackId = generateSessionId();
        setSessionId(fallbackId);
      }
    }
    loadSessionId();
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const sendPresenceUpdate = useCallback(
    async (threadId: string | null, force: boolean = false) => {
      if (DISABLE_PRESENCE || !isAuthenticated || !user || !sessionId) {
        return;
      }

      const threadKey = threadId || 'null';
      if (!force && lastSentThreadRef.current === threadKey && pendingRequestRef.current) {
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

      const requestPromise = (async () => {
        try {
          const token = await getAuthToken();
          if (!token) return;

          await fetch(`${API_URL}/presence/update`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              session_id: sessionId,
              active_thread_id: threadId,
              platform: Platform.OS,
              client_timestamp: timestamp,
            }),
          });
        } catch (err) {
          log.error('[Presence] Update failed:', err);
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
    [isAuthenticated, user, sessionId],
  );

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    if (!isAuthenticated || !user) {
      return;
    }
    heartbeatRef.current = setInterval(() => {
      sendPresenceUpdate(latestThreadRef.current);
    }, HEARTBEAT_INTERVAL);
  }, [sendPresenceUpdate, stopHeartbeat, isAuthenticated, user]);

  const disconnectChannel = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  const handlePresenceChange = useCallback((payload: any) => {
    if (!payload.new) return;
    
    const record = payload.new as {
      session_id: string;
      account_id: string;
      active_thread_id: string | null;
      platform: string;
      last_seen: string;
      client_timestamp: string;
    };

    if (!record.account_id) return;

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
    if (!payload.old) return;
    
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
    if (DISABLE_PRESENCE || !isAuthenticated || !user || channelRef.current) {
      return;
    }

    setConnectionState('connecting');

    const channel = supabase
      .channel('presence-updates-mobile')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_presence_sessions',
        },
        (payload: any) => {
          if (payload.eventType === 'DELETE') {
            handlePresenceDelete(payload);
          } else {
            handlePresenceChange(payload);
          }
        }
      )
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          setConnectionState('connected');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setConnectionState('error');
        } else if (status === 'CLOSED') {
          setConnectionState('idle');
        }
      });

    channelRef.current = channel;
  }, [isAuthenticated, user, handlePresenceChange, handlePresenceDelete]);

  const clearPresence = useCallback(async () => {
    if (DISABLE_PRESENCE || !sessionId || !API_URL) {
      return;
    }
    
    try {
      const token = await getAuthToken();
      if (!token) return;

      await fetch(`${API_URL}/presence/clear?token=${token}&session_id=${sessionId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      
      await AsyncStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (error) {
      log.error('[Presence] Failed to clear presence:', error);
    }
  }, [sessionId]);

  const setActiveThreadId = useCallback((threadId: string | null) => {
    const normalized = threadId || null;
    
    latestThreadRef.current = normalized;
    setActiveThreadState(normalized);
    
    if (DISABLE_PRESENCE || !isAuthenticated || !user) {
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      sendPresenceUpdate(normalized, true);
      startHeartbeat();
    }, DEBOUNCE_DELAY);
  }, [sendPresenceUpdate, startHeartbeat, isAuthenticated, user]);

  useEffect(() => {
    if (DISABLE_PRESENCE || !isAuthenticated || !user || !sessionId) {
      stopHeartbeat();
      disconnectChannel();
      setConnectionState('idle');
      setPresences({});
      latestThreadRef.current = null;
      setActiveThreadState(null);
      lastSentThreadRef.current = null;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      return;
    }
    
    sendPresenceUpdate(latestThreadRef.current, true);
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
  }, [connectChannel, disconnectChannel, sendPresenceUpdate, startHeartbeat, stopHeartbeat, isAuthenticated, user, sessionId]);

  useEffect(() => {
    if (DISABLE_PRESENCE || !isAuthenticated || !user) return;

    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const currentThread = latestThreadRef.current;

      if (nextAppState === 'active' && appStateRef.current.match(/inactive|background/)) {
        sendPresenceUpdate(currentThread, false);
        startHeartbeat();
        connectChannel();
      } else if (nextAppState === 'inactive' || nextAppState === 'background') {
        stopHeartbeat();
        disconnectChannel();
        sendPresenceUpdate(null, false);
      }

      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
      stopHeartbeat();
      disconnectChannel();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [isAuthenticated, user, sendPresenceUpdate, startHeartbeat, stopHeartbeat, connectChannel, disconnectChannel]);

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

