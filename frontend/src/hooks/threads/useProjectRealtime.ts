'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { threadKeys } from '@/hooks/threads/keys';
import { Project } from '@/lib/api/threads';

/**
 * Hook to subscribe to real-time project updates and invalidate React Query cache
 * This ensures the frontend immediately knows when sandbox data is updated
 */
export function useProjectRealtime(projectId?: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;

    const supabase = createClient();

    // Subscribe to project changes
    const channel = supabase
      .channel(`project-${projectId}`)
      .on(
        'postgres_changes',
        {
          event: '*', // Listen to all events (INSERT, UPDATE, DELETE)
          schema: 'public',
          table: 'projects',
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          // Check if sandbox data was updated
          const newData = payload.new as Project;
          const oldData = payload.old as Project;
          
          // Only consider it a real sandbox if it has an id field
          const hasRealSandbox = (sandbox: any) => sandbox && typeof sandbox === 'object' && sandbox.id;
          const newHasSandbox = hasRealSandbox(newData?.sandbox);
          const oldHasSandbox = hasRealSandbox(oldData?.sandbox);
          
          const sandboxChanged = newHasSandbox && !oldHasSandbox;
          
          if (sandboxChanged) {
            // Remove project cache to force recalculation with fresh data
            queryClient.removeQueries({
              queryKey: threadKeys.project(projectId)
            });
            
            // Refetch threads list (source of project data)
            queryClient.refetchQueries({
              queryKey: threadKeys.lists(),
              type: 'active'
            });
          }
        }
      )
      .subscribe();

    // Cleanup subscription
    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, queryClient]);
}
