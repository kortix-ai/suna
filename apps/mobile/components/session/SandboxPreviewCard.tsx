/**
 * SandboxPreviewCard — a running app named under a message.
 *
 * `text-part.tsx` renders one whenever an assistant message mentions a
 * `localhost:PORT` URL. It is the transcript's own row (`ResultRow`; Jay,
 * 2026-09-22): a screen glyph — **never a globe** — "App preview", the port
 * under it, a chevron, and the whole row opens the Browser tab. It replaced a
 * bordered card whose title was the raw URL and whose only obvious control was
 * a small "Open" pill on the right.
 */

import * as Haptics from 'expo-haptics';
import React, { useCallback } from 'react';

import { ResultRow } from '@/components/session/tool/shared/result-row';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { MonitorIcon } from '@/lib/icons';
import { getSandboxPortUrl } from '@/lib/platform/client';
import { useTabStore } from '@/stores/tab-store';

interface SandboxPreviewCardProps {
  /** The port number to preview */
  port: number;
  /** Optional title for the preview */
  title?: string;
  /** Optional description */
  description?: string;
  /** Optional path after the port */
  path?: string;
}

export function SandboxPreviewCard({ port, title, description, path }: SandboxPreviewCardProps) {
  const { sandboxId } = useSandboxContext();

  const handleOpen = useCallback(() => {
    if (!sandboxId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = getSandboxPortUrl(sandboxId, String(port)) + (path || '');
    useTabStore.getState().navigateToPage('page:browser');
    useTabStore.getState().setTabState('page:browser', {
      savedUrl: url,
      savedDisplay: `localhost:${port}${path || ''}`,
    });
  }, [sandboxId, port, path]);

  const where = `localhost:${port}${path || ''}`;

  return (
    <ResultRow
      icon={MonitorIcon}
      title={title || 'App preview'}
      // The description is the agent's own line about the app; the port is the
      // fallback, and it is what a reader needs to recognise the target.
      subtitle={description || where}
      onPress={sandboxId ? handleOpen : undefined}
      accessibilityLabel={`${title || 'App preview'}, ${where}`}
    />
  );
}

// ─── URL Detection ──────────────────────────────────────────────────────────

const LOCALHOST_REGEX = /https?:\/\/localhost:(\d+)(\/[^\s)]*)?/g;

export interface DetectedUrl {
  port: number;
  path: string;
  fullUrl: string;
}

export function detectLocalhostUrls(text: string): DetectedUrl[] {
  const urls: DetectedUrl[] = [];
  const seen = new Set<number>();
  let match;
  LOCALHOST_REGEX.lastIndex = 0;
  while ((match = LOCALHOST_REGEX.exec(text)) !== null) {
    const port = Number.parseInt(match[1], 10);
    if (!seen.has(port) && port > 0 && port < 65536) {
      seen.add(port);
      urls.push({
        port,
        path: match[2] || '',
        fullUrl: match[0],
      });
    }
  }
  return urls;
}
