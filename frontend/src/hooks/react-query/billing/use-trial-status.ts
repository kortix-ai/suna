import { useQuery } from '@tanstack/react-query';
import { getTrialStatus, startTrial } from '@/lib/api/billing-v2';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export function useTrialStatus() {
  return useQuery({
    queryKey: ['trial-status'],
    queryFn: getTrialStatus,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useStartTrial() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startTrial,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['trial-status'] });
      queryClient.invalidateQueries({ queryKey: ['billing-status'] });
      queryClient.invalidateQueries({ queryKey: ['credit-balance'] });
    },
    onError: (error: any) => {
      if (error?.message?.includes('already have')) {
        toast.error('You have already used your free trial');
      } else {
        toast.error('Failed to start trial. Please try again.');
      }
    },
  });
} 