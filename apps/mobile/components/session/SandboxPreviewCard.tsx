/**
 * SandboxPreviewCard — a running app named under a message.
 *
 * `text-part.tsx` renders one whenever the shared `@kortix/sdk`
 * `detectLocalhostUrls` finds a `localhost:PORT` URL in an assistant message.
 * It is the transcript's own row (`ResultRow`; Jay, 2026-09-22): a screen
 * glyph — **never a globe** — "App preview", the port under it, a chevron, and
 * the whole row opens the in-session preview sheet
 * (`SandboxPreviewSheet`, KRTX-602) over the session. It replaced a bordered
 * card whose title was the raw URL and whose only obvious control was a small
 * "Open" pill on the right.
 */

import * as Haptics from 'expo-haptics';
import React, { useCallback } from 'react';

import { ResultRow } from '@/components/session/tool/shared/result-row';
import { useToolNavigation } from '@/components/session/tool/shared/navigation';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { MonitorIcon } from '@/lib/icons';
import { getSandboxPortUrl } from '@/lib/platform/client';

interface SandboxPreviewCardProps {
  /** The port number to preview */
  port: number;
  /** Optional path after the port */
  path?: string;
}

export function SandboxPreviewCard({ port, path }: SandboxPreviewCardProps) {
  const { sandboxId } = useSandboxContext();
  const { openPreview } = useToolNavigation();

  const where = `localhost:${port}${path || ''}`;

  const handleOpen = useCallback(() => {
    if (!sandboxId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    openPreview(getSandboxPortUrl(sandboxId, String(port)) + (path || ''), where);
  }, [openPreview, sandboxId, port, path, where]);

  return (
    <ResultRow
      icon={MonitorIcon}
      title="App preview"
      // The port is what a reader needs to recognise the target.
      subtitle={where}
      onPress={sandboxId ? handleOpen : undefined}
      accessibilityLabel={`App preview, ${where}`}
    />
  );
}
