import { useQuery } from '@tanstack/react-query';
import { getActiveAgentRuns } from '@/lib/api/agents';
import { useMemo } from 'react';

/**
 * Hook to efficiently track agent running status for all threads
 * Returns a Map of threadId -> isRunning (true if agent is running for that thread)
 * 
 * This uses a single backend endpoint that returns all active agent runs,
 * which is much more efficient than querying each thread individually.
 * 
 * OPTIMIZED: Graceful error handling - returns empty array on failure
 * Uses smart polling that's disabled when no runs are active
 */
export function useThreadAgentStatuses(threadIds: string[]) {
  // Fetch all active agent runs - with smart polling
  const { data: activeRuns = [], isLoading } = useQuery({
    queryKey: ['active-agent-runs'],
    queryFn: getActiveAgentRuns,
    staleTime: 10 * 1000, // Cache for 10 seconds
    refetchInterval: (query) => {
      // Poll every 15 seconds if there are active runs, otherwise don't poll
      const hasActiveRuns = query.state.data && query.state.data.length > 0;
      return hasActiveRuns ? 15000 : false;
    },
    retry: 1,
    retryDelay: 5000,
    refetchOnWindowFocus: false, // Disable refetch on window focus to reduce load
  });

  // Create a map of threadId -> isRunning using useMemo for performance
  const statusMap = useMemo(() => {
    const map = new Map<string, boolean>();
    
    // Initialize all threads as not running
    threadIds.forEach(threadId => {
      map.set(threadId, false);
    });
    
    // Update map with active runs
    if (activeRuns && activeRuns.length > 0) {
      activeRuns.forEach(run => {
        map.set(run.thread_id, true);
      });
    }

    return map;
  }, [threadIds, activeRuns]);

  return statusMap;
}

