'use client';

import { useQuery } from '@tanstack/react-query';
import { billingApiV2 } from '@/lib/api/billing-v2';
import { useAuth } from '@/components/AuthProvider';

export const useCancellationStatus = () => {
  const { user } = useAuth();
  
  return useQuery({
    queryKey: ['subscription', 'cancellation-status'],
    queryFn: () => billingApiV2.getSubscriptionCancellationStatus(),
    enabled: !!user,
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });
};
