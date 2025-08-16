'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { threadKeys } from '@/hooks/react-query/threads/keys';
import { Project } from '../app/(dashboard)/projects/[projectId]/thread/_types';

/**
 * Hook to subscribe to real-time project updates and invalidate React Query cache
 * This ensures the frontend immediately knows when sandbox data is updated
 */
export function useProjectRealtime(projectId?: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;

    const supabase = createClient();
    
    console.log('🔄 Setting up real-time subscription for project:', projectId);

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
          console.log('📡 Real-time project update received:', payload);
          
          // Check if sandbox data was updated
          const newData = payload.new as Project;
          const oldData = payload.old as Project;
          if (newData?.sandbox && (!oldData?.sandbox || 
              JSON.stringify(newData.sandbox) !== JSON.stringify(oldData.sandbox))) {
            
            // Invalidate specific project query
            queryClient.invalidateQueries({
              queryKey: threadKeys.project(projectId)
            });
            
          }
        }
      )
      .subscribe((status) => {
        console.log('📡 Real-time subscription status:', status);
      });

    // Cleanup subscription
    return () => {
      console.log('🧹 Cleaning up real-time subscription for project:', projectId);
      supabase.removeChannel(channel);
    };
  }, [projectId, queryClient]);
}
