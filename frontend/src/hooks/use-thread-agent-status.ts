import { useQuery } from '@tanstack/react-query';
import { getActiveAgentRuns } from '@/lib/api';

/**
 * Hook to efficiently track agent running status for all threads
 * Returns a Map of threadId -> isRunning (true if agent is running for that thread)
 * 
 * This uses a single backend endpoint that returns all active agent runs,
 * which is much more efficient than querying each thread individually.
 */
export function useThreadAgentStatuses(threadIds: string[]) {
  // Fetch all active agent runs in a single query
  const { data: activeRuns } = useQuery({
    queryKey: ['active-agent-runs'],
    queryFn: getActiveAgentRuns,
    staleTime: 5000, // Cache for 5 seconds to avoid excessive refetching
    refetchInterval: 10000, // Refetch every 10 seconds to keep status updated
    retry: 1,
  });

  // Create a map of threadId -> isRunning
  const statusMap = new Map<string, boolean>();
  
  // Initialize all threads as not running
  threadIds.forEach(threadId => {
    statusMap.set(threadId, false);
  });
  
  // Update map with active runs
  if (activeRuns) {
    activeRuns.forEach(run => {
      statusMap.set(run.thread_id, true);
    });
  }

  return statusMap;
}

