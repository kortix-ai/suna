'use client';

import { useEffect } from 'react';
import { useWebNotificationStore } from '@/stores/web-notification-store';

/**
 * useWebNotifications
 *
 * Syncs browser notification permission state on mount.
 *
 * All notification dispatching (task completions, errors, questions, permissions)
 * is handled directly in the SSE event handler (use-opencode-events.ts) for
 * reliability — this avoids issues with event coalescing dropping intermediate
 * status transitions that React effects would miss.
 */
export function useWebNotifications() {
  // Sync browser permission on mount (in case user changed it in browser settings)
  useEffect(() => {
    useWebNotificationStore.getState().syncPermission();
  }, []);
}
