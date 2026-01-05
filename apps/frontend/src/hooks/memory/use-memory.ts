import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import {
  listMemories,
  getMemoryStats,
  deleteMemory,
  deleteAllMemories,
  createMemory,
  getMemorySettings,
  updateMemorySettings,
  getThreadMemorySettings,
  updateThreadMemorySettings,
  type Memory,
  type MemoryStats,
  type CreateMemoryRequest,
} from '@/lib/api/memory';
import { toast } from '@/lib/toast';

export function useMemoryStats() {
  return useQuery({
    queryKey: ['memory', 'stats'],
    queryFn: () => getMemoryStats(),
    staleTime: 30000,
  });
}

export function useMemories(page: number = 1, limit: number = 50, memoryType?: string) {
  return useQuery({
    queryKey: ['memory', 'list', page, limit, memoryType],
    queryFn: () => listMemories({ page, limit, memory_type: memoryType }),
    staleTime: 10000,
  });
}

export function useInfiniteMemories(limit: number = 50, memoryType?: string) {
  return useInfiniteQuery({
    queryKey: ['memory', 'list', 'infinite', limit, memoryType],
    queryFn: ({ pageParam = 1 }) => listMemories({ page: pageParam, limit, memory_type: memoryType }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      if (lastPage.page < lastPage.pages) {
        return lastPage.page + 1;
      }
      return undefined;
    },
    staleTime: 10000,
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (memoryId: string) => deleteMemory(memoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memory'] });
      toast.success('Memory deleted successfully');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to delete memory');
    },
  });
}

export function useDeleteAllMemories() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => deleteAllMemories(true),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['memory'] });
      toast.success(`Deleted ${data.deleted_count} memories`);
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to delete memories');
    },
  });
}

export function useCreateMemory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateMemoryRequest) => createMemory(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memory'] });
      toast.success('Memory created successfully');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to create memory');
    },
  });
}

export function useMemorySettings() {
  return useQuery({
    queryKey: ['memory', 'settings'],
    queryFn: () => getMemorySettings(),
    staleTime: 30000,
  });
}

export function useUpdateMemorySettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (enabled: boolean) => updateMemorySettings(enabled),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['memory'] });
      toast.success(data.memory_enabled ? 'Memory enabled' : 'Memory disabled');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to update memory settings');
    },
  });
}

export function useThreadMemorySettings(threadId: string | null) {
  return useQuery({
    queryKey: ['memory', 'thread', threadId, 'settings'],
    queryFn: () => getThreadMemorySettings(threadId!),
    enabled: !!threadId,
    staleTime: 30000,
    retry: false,
  });
}

export function useUpdateThreadMemorySettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, enabled }: { threadId: string; enabled: boolean }) => 
      updateThreadMemorySettings(threadId, enabled),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['memory', 'thread', data.thread_id] });
      toast.success(data.memory_enabled ? 'Memory enabled for this chat' : 'Memory disabled for this chat');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to update thread memory settings');
    },
  });
}
