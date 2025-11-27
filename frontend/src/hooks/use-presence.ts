import { useEffect } from 'react';
import { usePresenceContext } from '@/providers/presence-provider';

export function usePresence(threadId: string | null | undefined) {
  const { setActiveThreadId } = usePresenceContext();
  useEffect(() => {
    setActiveThreadId(threadId || null);
    return () => {
      setActiveThreadId(null);
    };
  }, [setActiveThreadId, threadId]);
}
