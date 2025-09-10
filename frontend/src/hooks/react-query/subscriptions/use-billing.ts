'use client';

import { createMutationHook, createQueryHook } from '@/hooks/use-query';
import {
  createCheckoutSession,
  checkBillingStatus,
  getAvailableModels,
  CreateCheckoutSessionRequest
} from '@/lib/api';
import { billingApi } from '@/lib/api-enhanced';
import { modelKeys, usageKeys } from './keys';

export const useAvailableModels = createQueryHook(
  modelKeys.available,
  getAvailableModels,
  {
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  }
);

export const useBillingStatus = createQueryHook(
  ['billing', 'status'],
  checkBillingStatus,
  {
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes cache time
    refetchOnWindowFocus: false, // Don't refetch on window focus
    refetchOnMount: false, // Don't refetch on mount if data exists
    refetchOnReconnect: true, // Only refetch when network reconnects
  }
);

export const useCreateCheckoutSession = createMutationHook(
  (request: CreateCheckoutSessionRequest) => createCheckoutSession(request),
  {
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
    errorContext: {
      operation: 'create checkout session',
      resource: 'billing'
    }
  }
);

export const useUsageLogs = (page: number = 0, itemsPerPage: number = 1000) => 
  createQueryHook(
    usageKeys.logs(page, itemsPerPage),
    () => billingApi.getUsageLogs(page, itemsPerPage),
    {
      staleTime: 30 * 1000, // 30 seconds
      refetchOnMount: true,
      refetchOnWindowFocus: false,
    }
  )();

export const useAdminUserUsageLogs = (accountId: string, page: number = 0, itemsPerPage: number = 1000, days: number = 30) => 
  createQueryHook(
    ['admin-user-usage', accountId, page, itemsPerPage, days],
    async () => {
      const response = await fetch(`/api/enterprise/admin/users/${accountId}?page=${page}&items_per_page=${itemsPerPage}&days=${days}`, {
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch user usage: ${response.statusText}`);
      }
      
      return response.json();
    },
    {
      staleTime: 30 * 1000, // 30 seconds
      refetchOnMount: true,
      refetchOnWindowFocus: false,
      enabled: !!accountId, // Only run if accountId is provided
    }
  )(); 