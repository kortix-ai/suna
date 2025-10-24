import { useQuery } from '@tanstack/react-query';
import { getActiveAgentRuns } from '@/lib/api';
import { useMemo } from 'react';

/**
 * Hook to efficiently track agent running status for all threads
 * Returns a Map of threadId -> isRunning (true if agent is running for that thread)
 * 
 * This uses a single backend endpoint that returns all active agent runs,
 * which is much more efficient than querying each thread individually.
 * 
 * OPTIMIZED: Removed automatic polling to reduce API load
 */
export function useThreadAgentStatuses(threadIds: string[]) {
  // Fetch all active agent runs in a single query - NO AUTOMATIC POLLING
  const { data: activeRuns, isLoading } = useQuery({
    queryKey: ['active-agent-runs'],
    queryFn: getActiveAgentRuns,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    refetchInterval: false, // Disable automatic polling
    retry: 1,
    refetchOnWindowFocus: false, // Disable refetch on window focus
  });

  // Create a map of threadId -> isRunning using useMemo for performance
  const statusMap = useMemo(() => {
    const map = new Map<string, boolean>();
    
    // Initialize all threads as not running
    threadIds.forEach(threadId => {
      map.set(threadId, false);
    });
    
    // Update map with active runs
    if (activeRuns) {
      activeRuns.forEach(run => {
        map.set(run.thread_id, true);
      });
    }

    return map;
  }, [threadIds, activeRuns]);

  return statusMap;
}

