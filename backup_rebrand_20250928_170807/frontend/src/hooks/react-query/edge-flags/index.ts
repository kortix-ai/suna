'use client';

import { createQueryHook, createQueryKeys } from '@/hooks/use-query';
import { IMaintenanceNotice } from '@/lib/edge-flags';

const maintenanceNoticeKeysBase = ['maintenanceNotice'] as const;

export const maintenanceNoticeKeys = createQueryKeys({
  all: maintenanceNoticeKeysBase,
});

export const useMaintenanceNoticeQuery = createQueryHook(
  maintenanceNoticeKeys.all,
  async (): Promise<IMaintenanceNotice> => {
    const response = await fetch('/api/edge-flags');
    const data = await response.json();
    return data;
  },
  {
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 3,
  },
);