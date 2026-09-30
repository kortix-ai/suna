import * as React from 'react';
import { useToast } from '@/components/kortix/toast-provider';
import { useConfirmDialog } from '@/components/kortix/confirm-dialog';
import { haptics } from '@/lib/haptics';
import { useCompactSession } from '@/lib/opencode/hooks/use-compact-session';
import { useSyncStore } from '@/lib/opencode/sync-store';

export function useSessionCompactConfirm() {
  const toast = useToast();
  const compactSession = useCompactSession();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  // The session and runtime a Compact tap was for, kept past the sheet's close.
  const compactTargetRef = React.useRef<{ sessionId: string; sandboxUrl: string } | null>(null);
    const runCompact = React.useCallback(() => {
      const target = compactTargetRef.current;
      compactTargetRef.current = null;
      if (!target) return;
      // The session may have started working while the dialog was up.
      const status = useSyncStore.getState().sessionStatus[target.sessionId];
      if (status?.type === 'busy' || status?.type === 'retry') {
        haptics.warning();
        toast.error('The session is working. Compact it when it stops.');
        return;
      }
      haptics.medium();
      // No progress or success toast: the thread's compaction divider mounts
      // at once (`startCompaction`) and becomes the server's compaction turn.
      compactSession.mutate(target, {
        onError: (error) => {
          haptics.warning();
          toast.error(error instanceof Error && error.message ? error.message : 'Unable to compact the session. Try again.');
        },
      });
    }, [compactSession, toast]);

  return { compactTargetRef, confirm, confirmDialog, runCompact };
}
