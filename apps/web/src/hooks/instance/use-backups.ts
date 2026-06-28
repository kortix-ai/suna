'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
} from '@/lib/platform-client';

export function useBackups(sandboxId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['backups', sandboxId];

  const query = useQuery({
    queryKey,
    queryFn: () => listBackups(sandboxId!),
    enabled: !!sandboxId,
    refetchInterval: (q) => {
      const backups = q.state.data?.backups;
      if (backups?.some((b) => b.status === 'creating')) return 5_000;
      return 30_000;
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (description?: string) => createBackup(sandboxId!, description),
    onSuccess: invalidate,
  });

  const restore = useMutation({
    mutationFn: (backupId: string) => restoreBackup(sandboxId!, backupId),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (backupId: string) => deleteBackup(sandboxId!, backupId),
    onSuccess: invalidate,
  });

  return {
    backups: query.data?.backups ?? [],
    backupsEnabled: query.data?.backups_enabled ?? false,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    create,
    restore,
    remove,
  };
}
