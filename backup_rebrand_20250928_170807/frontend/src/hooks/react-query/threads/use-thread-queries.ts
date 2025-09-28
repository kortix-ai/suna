'use client';

import { createQueryHook } from '@/hooks/use-query';
import { getThreads } from '@/lib/api';
import { threadKeys } from './keys';

export const useThreadsByProject = (projectId?: string) =>
  createQueryHook(
    threadKeys.byProject(projectId || ''),
    () => projectId ? getThreads(projectId) : Promise.resolve([]),
    {
      enabled: !!projectId,
      staleTime: 2 * 60 * 1000, 
      refetchOnWindowFocus: false,
    }
  )();

export const useAllThreads = createQueryHook(
  threadKeys.all,
  () => getThreads(),
  {
    staleTime: 2 * 60 * 1000, 
    refetchOnWindowFocus: false,
  }
); 