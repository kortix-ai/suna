import { useQuery } from "@tanstack/react-query";
import { threadKeys } from "@/hooks/threads/keys";
import { checkBillingStatus, type BillingStatusResponse } from "@/lib/api/billing";

export const useBillingStatusQuery = (enabled = true, options?) => {
  return useQuery<BillingStatusResponse>({
    queryKey: threadKeys.billingStatus,
    queryFn: () => checkBillingStatus(),
    enabled,
    retry: 1,
    staleTime: 1000 * 60 * 10, // 10 minutes - increased stale time
    gcTime: 1000 * 60 * 15, // 15 minutes cache time
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchInterval: (query: any) => {
      // Only refetch if billing is in a problematic state and at a slower rate
      if (query.state.data && !query.state.data.can_run) {
        return 1000 * 60 * 5; // 5 minutes instead of 1 minute
      }
      return false;
    },
    ...options,
  });
};

