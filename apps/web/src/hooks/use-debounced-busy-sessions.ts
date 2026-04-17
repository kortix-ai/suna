'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSyncStore } from '@/stores/opencode-sync-store';

/**
 * Debounced busy state — prevents green dot from flickering off between
 * agentic steps or during reasoning when the server briefly reports idle.
 *
 * Goes busy immediately, but debounces the transition to idle by `debounceMs`.
 */
export function useDebouncedBusySessions(debounceMs = 2000) {
  const syncMessages = useSyncStore((s) => s.messages);
  const statuses = useSyncStore((s) => s.sessionStatus);

  const rawBusy = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const sessionId of Object.keys(statuses)) {
      const statusBusy =
        statuses[sessionId]?.type === 'busy' ||
        statuses[sessionId]?.type === 'retry';

      if (statusBusy) {
        result[sessionId] = true;
        continue;
      }

      const msgs = syncMessages[sessionId];
      if (msgs && msgs.length > 0) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') {
            if (!(msgs[i] as any).time?.completed) {
              result[sessionId] = true;
            }
            break;
          }
        }
      }
    }
    return result;
  }, [statuses, syncMessages]);

  const [debouncedBusy, setDebouncedBusy] = useState<Record<string, boolean>>(rawBusy);
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const allIds = new Set([
      ...Object.keys(rawBusy),
      ...Object.keys(debouncedBusy),
    ]);

    for (const sessionId of allIds) {
      const isRawBusy = rawBusy[sessionId] ?? false;
      const isDebouncedBusy = debouncedBusy[sessionId] ?? false;

      if (isRawBusy && !isDebouncedBusy) {
        if (timersRef.current[sessionId]) {
          clearTimeout(timersRef.current[sessionId]);
          delete timersRef.current[sessionId];
        }
        setDebouncedBusy((prev) => ({ ...prev, [sessionId]: true }));
      } else if (!isRawBusy && isDebouncedBusy) {
        if (!timersRef.current[sessionId]) {
          timersRef.current[sessionId] = setTimeout(() => {
            delete timersRef.current[sessionId];
            setDebouncedBusy((prev) => ({ ...prev, [sessionId]: false }));
          }, debounceMs);
        }
      } else if (isRawBusy && isDebouncedBusy) {
        if (timersRef.current[sessionId]) {
          clearTimeout(timersRef.current[sessionId]);
          delete timersRef.current[sessionId];
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawBusy, debounceMs]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of Object.values(timers)) {
        clearTimeout(timer);
      }
    };
  }, []);

  return debouncedBusy;
}
