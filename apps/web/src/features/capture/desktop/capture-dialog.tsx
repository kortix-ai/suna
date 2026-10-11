'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { DESKTOP_CAPTURE_OPEN_COMMAND, isDesktop } from '@/lib/desktop';

import { CapturePermissions } from './capture-permissions';
import { missingGrants } from './capture-state';
import {
  captureRoutes,
  useCaptureOrganization,
  useDesktopCaptureActions,
  useDesktopCaptureStatus,
  useThisComputerAccountId,
} from './use-desktop-capture';

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
  return isDesktop() ? <CapturePermissionGate /> : null;
}

/**
 * The permission step, on whatever page the app is on: this computer records
 * for an account, and macOS has not granted what its layers need. Nothing is
 * recorded until it has, so the step comes to the person instead of waiting
 * on the "This computer" page. "Later" hides it until the app restarts; it
 * closes by itself once macOS answers.
 */
function CapturePermissionGate() {
  const t = useTranslations('capture.dialog.gate');
  const [later, setLater] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  const status = useDesktopCaptureStatus({ poll: wasOpen });
  const view = status.data ?? null;
  const accountId = view?.signedIn && view.on ? (view.accountId ?? null) : null;
  const org = useCaptureOrganization(accountId);
  const actions = useDesktopCaptureActions(accountId, { onWaitingOnPage: () => undefined });
  const missing = view && accountId ? missingGrants(view) : [];
  const open = !later && missing.length > 0;
  // Adjusted during render: the gate polls while open and says so once it closes on a grant.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open && !later && accountId && missing.length === 0) successToast(t('done'));
  }
  if (!view) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : setLater(true))}>
      <DialogContent hideCloseButton className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('body', { org: org.name })}</DialogDescription>
        </DialogHeader>
        <CapturePermissions
          view={view}
          requesting={actions.grants.isPending}
          onAllow={() =>
            actions.grants.mutate({
              audio: Boolean(view.layers?.audio),
              actions: Boolean(view.layers?.actions),
            })
          }
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setLater(true)}>
            {t('later')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Record this computer" on the Capture pages: opens the "This computer" page
 * and closes at once.
 */
export function CaptureDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const go = useOpenThisComputer();
  useEffect(() => {
    if (!open) return;
    go();
    onOpenChange(false);
  }, [open, go, onOpenChange]);
  return null;
}
