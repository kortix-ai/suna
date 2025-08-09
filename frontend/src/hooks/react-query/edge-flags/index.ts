'use client';

import { createQueryHook, createQueryKeys } from '@/hooks/use-query';
import { IMaintenanceNotice } from '@/lib/edge-flags';

const maintenanceNoticeKeysBase = ['maintenance-notice'] as const;

export const maintenanceNoticeKeys = createQueryKeys({
  all: maintenanceNoticeKeysBase,
});

export const useMaintenanceNoticeQuery = createQueryHook(
  maintenanceNoticeKeys.all,
  async (): Promise<IMaintenanceNotice> => {
    const response = await fetch('/api/edge-flags');
    return response.json();
  },
  {
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
    retry: 3,
  },
);
