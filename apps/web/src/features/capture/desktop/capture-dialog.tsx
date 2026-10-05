'use client';

import { useEffect, useState } from 'react';

import { Modal, ModalContent } from '@/components/ui/modal';
import { DESKTOP_CAPTURE_OPEN_COMMAND, isDesktop } from '@/lib/desktop';

import { CaptureThisComputer } from './capture-section';

/**
 * Capture's "This computer" as a dialog (desktop app). Organization-scoped:
 * it takes no project.
 */
export function CaptureDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* A column: on a short window only the body scrolls. No initial focus:
          events open it (the tray), and a focused first control reads as selected. */}
      <ModalContent className="flex flex-col lg:max-w-lg" onOpenAutoFocus={(event) => event.preventDefault()}>
        {open ? <CaptureThisComputer onClose={() => onOpenChange(false)} /> : null}
      </ModalContent>
    </Modal>
  );
}

/**
 * The dialog mounted once for every app route (the (app) layout), so the app
 * menu's "Capture…" and Capture's tray open it on any page. Desktop app only;
 * closed until opened.
 */
export function CaptureDesktopHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!isDesktop()) return;
    const onCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail === DESKTOP_CAPTURE_OPEN_COMMAND) setOpen(true);
    };
    window.addEventListener('kortix-desktop-command', onCommand);
    return () => window.removeEventListener('kortix-desktop-command', onCommand);
  }, []);
  return <CaptureDialog open={open} onOpenChange={setOpen} />;
}
