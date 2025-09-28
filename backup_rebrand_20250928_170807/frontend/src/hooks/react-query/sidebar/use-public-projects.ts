'use client';

import { createQueryHook } from '@/hooks/use-query';
import { getPublicProjects } from '@/lib/api';
import { projectKeys } from './keys';

export const usePublicProjects = createQueryHook(
  projectKeys.public(),
  getPublicProjects,
  {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  }
); 