'use client';

import { useQuery } from '@tanstack/react-query';
import { IMaintenanceNotice } from '@/lib/edge-flags';

const maintenanceNoticeKeysBase = ['maintenanceNotice'] as const;

export const maintenanceNoticeKeys = {
  all: maintenanceNoticeKeysBase,
} as const;

export const useMaintenanceNoticeQuery = (options?) => {
  return useQuery<IMaintenanceNotice>({
    queryKey: maintenanceNoticeKeys.all,
    queryFn: async (): Promise<IMaintenanceNotice> => {
      const response = await fetch('/api/edge-flags');
      const data = await response.json();
      return data;
    },
    staleTime: 5 * 60 * 1000, 
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false, 
    retry: 3,
    placeholderData: { enabled: false },
    ...options,
  });
};