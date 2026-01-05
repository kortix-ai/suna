import { useEffect, useRef } from 'react';
import { usePresenceContext } from '@/components/presence-provider';

export function usePresence(threadId: string | null | undefined) {
  const { setActiveThreadId } = usePresenceContext();
  const lastThreadIdRef = useRef<string | null | undefined>(undefined);
  
  useEffect(() => {
    const normalizedThreadId = threadId || null;
    
    // Only update if threadId has actually changed
    if (lastThreadIdRef.current === normalizedThreadId) {
      return;
    }
    
    lastThreadIdRef.current = normalizedThreadId;
    setActiveThreadId(normalizedThreadId);
    
    return () => {
      // Only clear if this was the last set value
      if (lastThreadIdRef.current === normalizedThreadId) {
        setActiveThreadId(null);
        lastThreadIdRef.current = undefined;
      }
    };
  }, [setActiveThreadId, threadId]);
}
