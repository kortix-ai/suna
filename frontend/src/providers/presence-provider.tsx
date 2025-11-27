'use client';

import { backendApi } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
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

const API_BASE = process.env.NEXT_PUBLIC_BACKEND_URL || '';
const HEARTBEAT_INTERVAL = 60000;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 30000;

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
      console.log('[Presence] Generated new session ID:', storedId.slice(0, 8));
    } else {
      console.log('[Presence] Loaded existing session ID:', storedId.slice(0, 8));
    }
    return storedId;
  });
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const latestThreadRef = useRef<string | null>(null);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const sendPresenceUpdate = useCallback(
    async (threadId: string | null) => {
      if (!user || !sessionId) {
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

  const disconnectStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const handlePresenceEvent = useCallback((raw: string) => {
    if (!raw) {
      return;
    }
    try {
      const payload: PresenceEventPayload = JSON.parse(raw);
      if (!payload.account_id) {
        return;
      }
      if (payload.type === 'presence_connected') {
        console.log('[Presence] Connected to presence stream');
        return;
      }
      console.log('[Presence] Event received:', payload);
      setPresences((prev) => {
        const key = `${payload.account_id}:${payload.session_id || 'unknown'}`;
        if (payload.status === 'offline' || payload.type === 'presence_clear') {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return {
          ...prev,
          [key]: payload,
        };
      });
    } catch (err) {
      console.error('[Presence] Failed to parse event:', err);
    }
  }, []);

  const connectStream = useCallback(() => {
    if (!API_BASE || !user || !session?.access_token || eventSourceRef.current) {
      return;
    }
    console.log('[Presence] Connecting to stream...');
    setConnectionState((state) => state === 'connected' ? state : 'connecting');
    const url = new URL(`${API_BASE}/presence/stream`);
    url.searchParams.set('token', session.access_token);
    const source = new EventSource(url.toString());
    eventSourceRef.current = source;
    source.onopen = () => {
      console.log('[Presence] Stream connected');
      reconnectAttemptsRef.current = 0;
      setConnectionState('connected');
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
    source.onmessage = (event) => {
      handlePresenceEvent(event.data);
    };
    source.onerror = (err) => {
      console.error('[Presence] Stream error:', err);
      setConnectionState('error');
      disconnectStream();
      if (!user || !session.access_token) {
        return;
      }
      const attempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = attempt;
      const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, attempt - 1));
      console.log(`[Presence] Reconnecting in ${delay}ms (attempt ${attempt})`);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectStream();
      }, delay);
    };
  }, [disconnectStream, handlePresenceEvent, session?.access_token, user]);

  const sendBeaconClear = useCallback(() => {
    if (typeof navigator === 'undefined' || !sessionId) {
      return;
    }
    if (!API_BASE || !session?.access_token) {
      return;
    }
    const url = new URL(`${API_BASE}/presence/clear`);
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
    if (!user) {
      return;
    }
    sendPresenceUpdate(normalized);
    startHeartbeat();
  }, [sendPresenceUpdate, startHeartbeat, user]);

  useEffect(() => {
    if (!user) {
      stopHeartbeat();
      disconnectStream();
      setConnectionState('idle');
      setPresences({});
      latestThreadRef.current = null;
      setActiveThreadState(null);
      return;
    }
    sendPresenceUpdate(latestThreadRef.current);
    startHeartbeat();
    connectStream();
    return () => {
      stopHeartbeat();
      disconnectStream();
    };
  }, [connectStream, disconnectStream, sendPresenceUpdate, startHeartbeat, stopHeartbeat, user]);

  useEffect(() => {
    if (typeof document === 'undefined') {
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
