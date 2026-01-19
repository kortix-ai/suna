'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { threadKeys } from '@/hooks/threads/keys';

export function useProjectRealtime(projectId?: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;

    const supabase = createClient();

    const channel = supabase
      .channel(`project-${projectId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'projects',
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          const newData = payload.new as Record<string, unknown>;
          const oldData = payload.old as Record<string, unknown>;
          const newSandboxResourceId = newData?.sandbox_resource_id;
          const oldSandboxResourceId = oldData?.sandbox_resource_id;
          const sandboxAssigned = newSandboxResourceId && !oldSandboxResourceId;
          
          if (sandboxAssigned) {
            queryClient.invalidateQueries({
              queryKey: threadKeys.project(projectId)
            });
            queryClient.refetchQueries({
              queryKey: threadKeys.lists(),
              type: 'active'
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, queryClient]);
}
