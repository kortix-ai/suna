'use client';

/**
 * /projects/[id]/settings/[tab] — deep-link entry into the merged Settings
 * overlay for a specific tab (e.g. `/settings/secrets`).
 *
 * Mirrors `customize/[section]/page.tsx`'s parse-or-redirect shape: a
 * segment that resolves through `parseSettingsTab` opens the overlay on it;
 * anything else (a typo, a stale bookmark, or a legacy `CustomizeSection` id
 * like `git` / `llm-management` — those only resolve through
 * `legacySectionRedirect`, which is not wired into this route yet) falls
 * back to the bare `/projects/[id]/settings` route rather than opening on a
 * tab that doesn't exist.
 *
 * Like the bare route above, this page mounts `SettingsPanel` itself instead
 * of bouncing away to a route that renders it — see that file's header
 * comment for why. Only the recognized-tab branch renders it; the
 * redirect branch returns null, same as `customize/[section]/page.tsx`,
 * since there's nothing useful to show while navigating away.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { SettingsPanel } from '@/features/workspace/settings/settings-panel';
import { parseSettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

export default function ProjectSettingsTabPage() {
  const params = useParams<{ id: string; tab: string }>();
  const projectId = params?.id ?? '';
  const tab = parseSettingsTab(params?.tab);
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    if (!tab) {
      router.replace(`/projects/${projectId}/settings`);
      return;
    }
    useSettingsPanelStore.getState().openSettings(tab);
  }, [projectId, tab, router]);

  if (!projectId || !tab) return null;
  return <SettingsPanel projectId={projectId} />;
}
