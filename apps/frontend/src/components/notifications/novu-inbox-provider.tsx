'use client';

import React, { createContext, useContext, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';

/**
 * Novu Inbox Context
 * 
 * This provider ensures the Novu session is only initialized ONCE
 * and prevents the excessive /v1/inbox/session API calls that happen
 * when the Inbox component re-mounts on every parent re-render.
 */

interface NovuInboxContextValue {
  applicationIdentifier: string | null;
  subscriberId: string | null;
  isReady: boolean;
  sessionKey: string;
}

const NovuInboxContext = createContext<NovuInboxContextValue | null>(null);

export function useNovuInbox() {
  const context = useContext(NovuInboxContext);
  if (!context) {
    throw new Error('useNovuInbox must be used within NovuInboxProvider');
  }
  return context;
}

interface NovuInboxProviderProps {
  children: React.ReactNode;
}

export function NovuInboxProvider({ children }: NovuInboxProviderProps) {
  const { user } = useAuth();
  const applicationIdentifier = process.env.NEXT_PUBLIC_NOVU_APP_IDENTIFIER || null;
  
  // Generate a stable session key that only changes when user changes
  // This prevents unnecessary re-initialization of the Inbox component
  const sessionKey = useMemo(() => {
    if (!user?.id || !applicationIdentifier) return '';
    return `novu-${user.id}-${applicationIdentifier}`;
  }, [user?.id, applicationIdentifier]);

  const isReady = Boolean(user?.id && applicationIdentifier);

  const value = useMemo<NovuInboxContextValue>(() => ({
    applicationIdentifier,
    subscriberId: user?.id || null,
    isReady,
    sessionKey,
  }), [applicationIdentifier, user?.id, isReady, sessionKey]);

  return (
    <NovuInboxContext.Provider value={value}>
      {children}
    </NovuInboxContext.Provider>
  );
}

/**
 * Helper hook to get stable appearance config
 * This ensures the appearance object reference doesn't change on every render
 */
export function useNovuAppearance() {
  return useMemo(() => ({
    variables: {
      colorBackground: 'var(--card)',
      borderRadius: '8px',
      colorForeground: 'var(--foreground)',
      colorPrimary: 'var(--primary)',
      colorSecondary: 'var(--secondary)',
      colorDestructive: 'var(--destructive)',
      colorMuted: 'var(--muted)',
      colorAccent: 'var(--accent)',
      colorPopover: 'var(--popover)',
    },
  }), []);
}

