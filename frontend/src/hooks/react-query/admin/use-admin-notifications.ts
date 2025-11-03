import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  sendGlobalNotification,
  listGlobalNotificationBatches,
  getGlobalNotificationBatch,
  cancelGlobalNotificationBatch,
  type GlobalNotificationRequest,
  type GlobalNotificationBatch,
  type GlobalNotificationBatchDetail,
} from '@/lib/api';
import { toast } from 'sonner';

// Query keys
export const adminNotificationKeys = {
  all: ['admin', 'notifications'] as const,
  lists: () => [...adminNotificationKeys.all, 'list'] as const,
  list: (params?: { page?: number; page_size?: number }) =>
    [...adminNotificationKeys.lists(), params] as const,
  details: () => [...adminNotificationKeys.all, 'detail'] as const,
  detail: (batchId: string) => [...adminNotificationKeys.details(), batchId] as const,
};

// List global notification batches
export function useAdminNotificationBatches(params?: { page?: number; page_size?: number }) {
  return useQuery({
    queryKey: adminNotificationKeys.list(params),
    queryFn: () => listGlobalNotificationBatches(params),
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: 60 * 1000, // Refetch every minute to update status
  });
}

// Get single batch details
export function useAdminNotificationBatch(batchId: string | null) {
  return useQuery({
    queryKey: adminNotificationKeys.detail(batchId || ''),
    queryFn: () => getGlobalNotificationBatch(batchId!),
    enabled: !!batchId,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // Refetch every minute to update status
  });
}

// Send global notification mutation
export function useSendGlobalNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: GlobalNotificationRequest) => sendGlobalNotification(request),
    onSuccess: (data: { batch_id: string; status: string; message: string; title: string }) => {
      queryClient.invalidateQueries({ queryKey: adminNotificationKeys.lists() });
      toast.success(`Global notification "${data.title}" queued for sending`, {
        description: 'Sending will begin immediately in the background. Check Batch History to track progress.',
        duration: 5000,
      });
    },
    onError: (error) => {
      toast.error('Failed to send global notification');
      console.error('Error sending global notification:', error);
    },
  });
}

// Cancel global notification batch mutation
export function useCancelGlobalNotificationBatch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (batchId: string) => cancelGlobalNotificationBatch(batchId),
    onSuccess: (data: { batch_id: string; status: string; message: string }, batchId: string) => {
      // Invalidate both list and detail queries to refresh status
      queryClient.invalidateQueries({ queryKey: adminNotificationKeys.lists() });
      queryClient.invalidateQueries({ queryKey: adminNotificationKeys.detail(batchId) });
      toast.success('Notification batch cancellation requested', {
        description: data.message || 'Processing will stop at next checkpoint.',
        duration: 5000,
      });
    },
    onError: (error: any) => {
      const errorMessage = error?.message || 'Failed to cancel notification batch';
      toast.error(errorMessage);
      console.error('Error cancelling global notification batch:', error);
    },
  });
}

