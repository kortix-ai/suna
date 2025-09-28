'use client';

import { createMutationHook, createQueryHook } from '@/hooks/use-query';
import {
  getSubscription,
  getSubscriptionCommitment,
  createPortalSession,
  SubscriptionStatus,
  CommitmentInfo,
} from '@/lib/api';
import { subscriptionKeys } from './keys';
import { useQuery } from '@tanstack/react-query';
import { useState, useEffect } from 'react';

export const useSubscription = createQueryHook(
  subscriptionKeys.details(),
  getSubscription,
  {
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: true,
  },
);

export const useSubscriptionWithStreaming = (isStreaming: boolean = false) => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return useQuery({
    queryKey: subscriptionKeys.details(),
    queryFn: getSubscription,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchInterval: (data) => {
      if (!isVisible) return false;
      if (isStreaming) return 2 * 60 * 1000;
      return 10 * 60 * 1000;
    },
    refetchIntervalInBackground: false,
  });
};

export const useCreatePortalSession = createMutationHook(
  (params: { return_url: string }) => createPortalSession(params),
  {
    onSuccess: (data) => {
      if (data?.url) {
        window.location.href = data.url;
      }
    },
  },
);

export const useSubscriptionCommitment = (subscriptionId?: string, enabled = true) => {
  return useQuery({
    queryKey: subscriptionKeys.commitment(subscriptionId || ''),
    queryFn: () => getSubscriptionCommitment(subscriptionId!),
    enabled: enabled && !!subscriptionId,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
};

export const isPlan = (
  subscriptionData: SubscriptionStatus | null | undefined,
  planId?: string,
): boolean => {
  if (!subscriptionData) return planId === 'free';
  return subscriptionData.plan_name === planId;
};
