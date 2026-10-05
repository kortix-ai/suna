'use client';

import { useEffect } from 'react';

import { DESKTOP_CAPTURE_SETTINGS_COMMAND } from '@/lib/desktop';

/**
 * Opens "Your computer" at My Capture: the same event the desktop tray's
 * "Settings…" sends. The workspace menu owns that dialog.
 */
export function openMyCapture() {
  window.dispatchEvent(new CustomEvent('kortix-desktop-command', { detail: DESKTOP_CAPTURE_SETTINGS_COMMAND }));
}

/**
 * "Record this computer" on the Capture pages: hands off to My Capture in
 * "Your computer" and closes at once.
 */
export function CaptureDialog({ open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  useEffect(() => {
    if (!open) return;
    openMyCapture();
    onOpenChange(false);
  }, [open, onOpenChange]);
  return null;
}
