/**
 * useRecoverPendingPick — Android-only. On mount, checks whether
 * `expo-image-picker` finished a camera or library pick after the host
 * activity was killed (`Don't keep activities`), and feeds any recovered
 * photo to the composer's `attachments.add` as if it had just been picked.
 *
 * `createPendingPickRecovery` (`lib/session/pending-picker-result.ts`) is a
 * module-level singleton, so `ImagePicker.getPendingResultAsync` is called at
 * most once per JS realm. When both `SessionChatInput` and `ProjectHome` are
 * mounted in the project stack, only the one that calls `consume()` first
 * gets the file — the other gets `[]`, so the photo lands exactly once.
 */
import * as React from 'react';
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { useToast } from '@/components/kortix/toast-provider';
import { log } from '@/lib/logger';
import { createPendingPickRecovery } from '@/lib/session/pending-picker-result';
import type { AttachedFile } from '@/lib/session/attachments';

const pendingPickRecovery = createPendingPickRecovery(ImagePicker.getPendingResultAsync);

export function useRecoverPendingPick(onPick: (files: AttachedFile[]) => void): void {
  const toast = useToast();
  const onPickRef = React.useRef(onPick);
  onPickRef.current = onPick;

  React.useEffect(() => {
    if (Platform.OS !== 'android') return;

    pendingPickRecovery
      .consume()
      .then((files) => {
        if (files.length === 0) return;
        onPickRef.current(files);
        toast.success('Photo attached.');
      })
      .catch((err: unknown) => log.warn('useRecoverPendingPick: consume failed', err));
    // Runs once per mount to check for a pending pick left by activity death.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
