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

// Check if presence is disabled via environment variable
const DISABLE_PRESENCE = process.env.NEXT_PUBLIC_DISABLE_PRESENCE === 'true';

function generateSessionId(): string {
  return crypto.randomUUID();
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

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const sendPresenceUpdate = useCallback(
    async (threadId: string | null) => {
      if (DISABLE_PRESENCE || !user || !sessionId) {
        return;
      }
      const timestamp = new Date().toISOString();
      try {
        await backendApi.post('/presence/update', {
          session_id: sessionId,
          active_thread_id: threadId,
          platform: 'web',
          client_timestamp: timestamp,
        }, { showErrors: false });
      } catch (err) {
        console.error('[Presence] Update failed:', err);
      }
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
    latestThreadRef.current = normalized;
    setActiveThreadState(normalized);
    if (DISABLE_PRESENCE || !user) {
      return;
    }
    sendPresenceUpdate(normalized);
    startHeartbeat();
  }, [sendPresenceUpdate, startHeartbeat, user]);

  useEffect(() => {
    if (DISABLE_PRESENCE || !user) {
      stopHeartbeat();
      disconnectChannel();
      setConnectionState('idle');
      setPresences({});
      latestThreadRef.current = null;
      setActiveThreadState(null);
      return;
    }
    
    sendPresenceUpdate(latestThreadRef.current);
    startHeartbeat();
    connectChannel();
    
    return () => {
      stopHeartbeat();
      disconnectChannel();
    };
  }, [connectChannel, disconnectChannel, sendPresenceUpdate, startHeartbeat, stopHeartbeat, user]);

  useEffect(() => {
    if (DISABLE_PRESENCE || typeof document === 'undefined') {
      return;
    }
    const handleVisibilityChange = () => {
      if (!user) {
        return;
      }
      if (document.hidden) {
        stopHeartbeat();
        sendPresenceUpdate(null);
      } else {
        sendPresenceUpdate(latestThreadRef.current);
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
