import { useQuery } from '@tanstack/react-query';
import { getTrialStatus, startTrial } from '@/lib/api/billing-v2';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export function useTrialStatus() {
  return useQuery({
    queryKey: ['trial-status'],
    queryFn: getTrialStatus,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
}

export function useStartTrial() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: startTrial,
    onSuccess: (data) => {
      if (data.trial_started) {
        toast.success(data.message || 'Your free trial has started!');
        // Invalidate related queries
        queryClient.invalidateQueries({ queryKey: ['trial-status'] });
        queryClient.invalidateQueries({ queryKey: ['billing-status'] });
        queryClient.invalidateQueries({ queryKey: ['credit-balance'] });
      } else if (data.requires_checkout) {
        // This will be handled by the component
      }
    },
    onError: (error: any) => {
      if (error?.message?.includes('already have a trial')) {
        toast.error('You have already used your free trial');
      } else {
        toast.error('Failed to start trial. Please try again.');
      }
    },
  });
} 