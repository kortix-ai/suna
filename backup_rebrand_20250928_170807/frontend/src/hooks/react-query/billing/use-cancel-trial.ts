import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cancelTrial } from '@/lib/api/billing-v2';
import { toast } from 'sonner';

export function useCancelTrial() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: cancelTrial,
    onSuccess: (data) => {
      toast.success(data.message || 'Trial cancelled successfully');
      queryClient.invalidateQueries({ queryKey: ['trial-status'] });
      queryClient.invalidateQueries({ queryKey: ['subscription'] });
      queryClient.invalidateQueries({ queryKey: ['credit-balance'] });
    },
    onError: (error: any) => {
      const message = error?.response?.data?.detail || error?.message || 'Failed to cancel trial';
      toast.error(message);
    }
  });
} 