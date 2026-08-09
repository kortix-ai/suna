'use client';

/**
 * /projects/[id]/settings/[tab] — deep-link entry into the merged Settings
 * overlay for a specific tab (e.g. `/settings/secrets`).
 *
 * Mirrors `customize/[section]/page.tsx`'s parse-or-redirect shape: a
 * segment that resolves through `parseSettingsTab` opens the overlay on it,
 * then bounces to the project home behind it — `ProjectShell` mounts
 * `SettingsPanel` persistently, so this route's only job is to set store
 * state and leave. Anything else (a typo, a stale bookmark) falls back to
 * the bare `/projects/[id]/settings` route rather than opening on a tab that
 * doesn't exist.
 *
 * This page used to render `SettingsPanel` directly, because nothing else
 * mounted it yet. Now that `ProjectShell` does, rendering it here too would
 * stack a second full-viewport `Modal` on the same store — and closing the
 * overlay from THIS route used to leave a blank page, since nothing else was
 * ever rendered here. Redirecting away fixes both.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

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
    router.replace(`/projects/${projectId}`);
  }, [projectId, tab, router]);

  return null;
}
