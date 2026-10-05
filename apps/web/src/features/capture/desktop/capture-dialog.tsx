'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';

import { DESKTOP_CAPTURE_OPEN_COMMAND, isDesktop } from '@/lib/desktop';

import { captureRoutes, useThisComputerAccountId } from './use-desktop-capture';

/** Goes to "This computer" for the account this computer records for (or the selected one). */
function useOpenThisComputer() {
  const router = useRouter();
  const accountId = useThisComputerAccountId();
  return useCallback(() => {
    if (accountId) router.push(captureRoutes.thisComputer(accountId));
  }, [router, accountId]);
}

/**
 * The desktop app's "Kortix Capture…" (app menu) and "Open Kortix Capture…"
 * (its menu bar item) send `capture-open`; this navigates the window to
 * "This computer". Mounted once for every app route (the (app) layout).
 */
export function CaptureDesktopHost() {
  const open = useOpenThisComputer();
  useEffect(() => {
    if (!isDesktop()) return;
    const onCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail === DESKTOP_CAPTURE_OPEN_COMMAND) open();
    };
    window.addEventListener('kortix-desktop-command', onCommand);
    return () => window.removeEventListener('kortix-desktop-command', onCommand);
  }, [open]);
  return null;
}

/**
 * "Record this computer" on the Capture pages: opens the "This computer" page
 * and closes at once.
 */
export function CaptureDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const go = useOpenThisComputer();
  useEffect(() => {
    if (!open) return;
    go();
    onOpenChange(false);
  }, [open, go, onOpenChange]);
  return null;
}
