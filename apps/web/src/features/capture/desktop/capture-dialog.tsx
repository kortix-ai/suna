'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import {
  DESKTOP_CAPTURE_EXCLUSIONS_COMMAND,
  DESKTOP_CAPTURE_OPEN_COMMAND,
  isDesktop,
} from '@/lib/desktop';

import { CapturePermissions } from './capture-permissions';
import { missingGrants } from './capture-state';
import {
  captureRoutes,
  useCaptureOrganization,
  useDesktopCaptureActions,
  useDesktopCaptureStatus,
  useThisComputerAccountId,
} from './use-desktop-capture';

/**
 * Goes to "This computer" for the account this computer records for (or the
 * selected one); `exclusions` opens its Exclusions tab.
 */
function useOpenThisComputer() {
  const router = useRouter();
  const accountId = useThisComputerAccountId();
  return useCallback(
    (section?: 'exclusions') => {
      if (!accountId) return;
      const href = captureRoutes.thisComputer(accountId);
      router.push(section ? `${href}?tab=${section}` : href);
    },
    [router, accountId],
  );
}

/**
 * The desktop app's "Kortix Capture…" (app menu) and "Open Kortix Capture…"
 * (its menu bar item) send `capture-open`, its "Kortix Capture settings…"
 * `capture-open-exclusions`; this navigates the window to "This computer".
 * Mounted once for every app route (the (app) layout).
 */
export function CaptureDesktopHost() {
  const open = useOpenThisComputer();
  useEffect(() => {
    if (!isDesktop()) return;
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === DESKTOP_CAPTURE_OPEN_COMMAND) open();
      if (command === DESKTOP_CAPTURE_EXCLUSIONS_COMMAND) open('exclusions');
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
    <Modal open={open} onOpenChange={(next) => (next ? undefined : setLater(true))}>
      <ModalContent showCloseButton={false} closeOnOutsideClick={false} className="sm:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('body', { org: org.name })}</ModalDescription>
        </ModalHeader>
        <ModalBody>
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
        </ModalBody>
        <ModalFooter className="pb-5">
          <Button variant="ghost" size="sm" onClick={() => setLater(true)}>
            {t('later')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
