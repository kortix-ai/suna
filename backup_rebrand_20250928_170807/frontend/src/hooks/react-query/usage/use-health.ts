'use client';

import { createQueryHook } from '@/hooks/use-query';
import { checkApiHealth } from '@/lib/api';
import { healthKeys } from '../files/keys';

export const useApiHealth = createQueryHook(
  healthKeys.api(),
  checkApiHealth,
  {
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 3,
  }
); 