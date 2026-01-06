/**
 * Hook for fetching sub-agent threads for a parent thread
 */

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { threadKeys } from './keys';

export interface SubAgentThread {
  thread_id: string;
  name: string | null;
  parent_thread_id: string;
  depth_level: number;
  created_at: string;
  updated_at: string;
  // Latest agent run status
  latest_run?: {
    id: string;
    status: string;
    metadata: {
      task_description?: string;
    } | null;
    started_at: string | null;
    completed_at: string | null;
  } | null;
}

export interface ParentThreadInfo {
  thread_id: string;
  name: string | null;
  project_id: string;
}

async function fetchSubAgentThreads(threadId: string): Promise<SubAgentThread[]> {
  const supabase = createClient();
  
  // Fetch all threads that have this thread as their parent
  const { data: subThreads, error } = await supabase
    .from('threads')
    .select(`
      thread_id,
      name,
      parent_thread_id,
      depth_level,
      created_at,
      updated_at
    `)
    .eq('parent_thread_id', threadId)
    .order('created_at', { ascending: false });
    
  if (error) {
    console.error('Error fetching sub-agent threads:', error);
    throw error;
  }
  
  if (!subThreads || subThreads.length === 0) {
    return [];
  }
  
  // For each sub-thread, get the latest agent run to show status
  const subThreadIds = subThreads.map(t => t.thread_id);
  
  const { data: agentRuns, error: runsError } = await supabase
    .from('agent_runs')
    .select(`
      id,
      thread_id,
      status,
      metadata,
      started_at,
      completed_at
    `)
    .in('thread_id', subThreadIds)
    .order('created_at', { ascending: false });
    
  if (runsError) {
    console.warn('Error fetching agent runs for sub-threads:', runsError);
  }
  
  // Map latest run to each thread
  const runsByThread = new Map<string, typeof agentRuns[0]>();
  for (const run of agentRuns || []) {
    if (!runsByThread.has(run.thread_id)) {
      runsByThread.set(run.thread_id, run);
    }
  }
  
  return subThreads.map(thread => ({
    ...thread,
    latest_run: runsByThread.get(thread.thread_id) || null
  }));
}

async function fetchParentThread(threadId: string): Promise<ParentThreadInfo | null> {
  const supabase = createClient();
  
  // First get current thread's parent_thread_id
  const { data: currentThread, error: currentError } = await supabase
    .from('threads')
    .select('parent_thread_id')
    .eq('thread_id', threadId)
    .maybeSingle();
    
  if (currentError || !currentThread?.parent_thread_id) {
    return null;
  }
  
  // Then fetch parent thread info
  const { data: parentThread, error } = await supabase
    .from('threads')
    .select('thread_id, name, project_id')
    .eq('thread_id', currentThread.parent_thread_id)
    .maybeSingle();
    
  if (error || !parentThread) {
    return null;
  }
  
  return parentThread;
}

/**
 * Hook to get sub-agent threads for a parent thread
 */
export function useSubAgentThreads(threadId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...threadKeys.details(threadId), 'sub-agents'],
    queryFn: () => fetchSubAgentThreads(threadId),
    enabled: options?.enabled !== false && !!threadId,
    staleTime: 10000, // 10 seconds
    refetchInterval: 5000, // Poll every 5 seconds to catch status updates
  });
}

/**
 * Hook to get parent thread info if current thread is a sub-agent
 */
export function useParentThread(threadId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...threadKeys.details(threadId), 'parent'],
    queryFn: () => fetchParentThread(threadId),
    enabled: options?.enabled !== false && !!threadId,
    staleTime: 60000, // 1 minute - parent info doesn't change often
  });
}

