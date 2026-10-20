'use client';

import type { SessionReminderState } from '@kortix/sdk';
import { useCallback, useState } from 'react';

/**
 * The List view's state tab. The list is one reminders query filtered per
 * tab, so switching tabs refetches it: a reminder paused or finished
 * elsewhere (the CLI, another browser tab) shows under the right tab without
 * a reload (KRTX-2888).
 */
export function useReminderTab(refetch: () => unknown) {
  const [tab, setTab] = useState<SessionReminderState>('active');
  const changeTab = useCallback(
    (next: SessionReminderState) => {
      setTab(next);
      void refetch();
    },
    [refetch],
  );
  return [tab, changeTab] as const;
}
