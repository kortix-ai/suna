'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import { useParams } from 'next/navigation';

import { CaptureDialogHost } from '@/features/capture/desktop/capture-dialog';
import { isDesktop } from '@/lib/desktop';

/**
 * Kortix Capture in the sidebar: no row. The timeline opens from a direct
 * link, the desktop app and the tray (`/projects/:id/capture`). In the desktop
 * app, this mounts the Capture dialog that the tray's "Capture…" opens, while
 * the project's `capture` feature flag is on.
 */
export function ProjectCaptureNavItem() {
  const projectId = useParams<{ id: string }>()?.id;
  const gate = useFeatureFlag(projectId, 'capture');
  if (!projectId || !gate.enabled || !isDesktop()) return null;
  return <CaptureDialogHost projectId={projectId} />;
}
