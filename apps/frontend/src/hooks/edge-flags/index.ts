'use client';

import { useQuery } from '@tanstack/react-query';
import { IMaintenanceNotice, ITechnicalIssue } from '@/lib/edge-flags';

const edgeFlagsKeysBase = ['edgeFlags'] as const;
const maintenanceNoticeKeysBase = ['maintenanceNotice'] as const;
const technicalIssueKeysBase = ['technicalIssue'] as const;

export const edgeFlagsKeys = {
  all: edgeFlagsKeysBase,
} as const;

export const maintenanceNoticeKeys = {
  all: maintenanceNoticeKeysBase,
} as const;

export const technicalIssueKeys = {
  all: technicalIssueKeysBase,
} as const;

interface EdgeFlagsResponse {
  maintenanceNotice: IMaintenanceNotice;
  technicalIssue: ITechnicalIssue;
}

export const useEdgeFlagsQuery = (options?) => {
  return useQuery<EdgeFlagsResponse>({
    queryKey: edgeFlagsKeys.all,
    queryFn: async (): Promise<EdgeFlagsResponse> => {
      const response = await fetch('/api/edge-flags');
      const data = await response.json();
      return data;
    },
    staleTime: 5 * 60 * 1000, 
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false, 
    retry: 3,
    placeholderData: { 
      maintenanceNotice: { enabled: false },
      technicalIssue: { enabled: false }
    },
    ...options,
  });
};

export const useMaintenanceNoticeQuery = (options?) => {
  return useQuery<IMaintenanceNotice>({
    queryKey: maintenanceNoticeKeys.all,
    queryFn: async (): Promise<IMaintenanceNotice> => {
      const response = await fetch('/api/edge-flags');
      const data = await response.json();
      return data.maintenanceNotice || data;
    },
    staleTime: 5 * 60 * 1000, 
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false, 
    retry: 3,
    placeholderData: { enabled: false },
    ...options,
  });
};

export const useTechnicalIssueQuery = (options?) => {
  return useQuery<ITechnicalIssue>({
    queryKey: technicalIssueKeys.all,
    queryFn: async (): Promise<ITechnicalIssue> => {
      //  return {
      //    enabled: true,
      //    message: 'We are investigating issues with MCP tool loading',
      //    statusUrl: '/status',
      //    affectedServices: ['Agent Processing'],
      //    description: 'Some users may experience issues where MCP tools do not load properly for their agents, even though the tools have been successfully added. Our team is actively investigating this issue and working on a fix.',
      //    estimatedResolution: '1-2 hours',
      //    severity: 'degraded',
      //  };
      
      const response = await fetch('/api/edge-flags');
      const data = await response.json();
      return data.technicalIssue || { enabled: false };
    },
    staleTime: 5 * 60 * 1000, 
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false, 
    retry: 3,
    placeholderData: { enabled: false },
    ...options,
  });
};