'use client';

/**
 * /projects/[id]/settings/[tab] — deep-link entry into the merged Settings
 * overlay for a specific tab (e.g. `/settings/secrets`).
 *
 * Mirrors `customize/[section]/page.tsx`'s parse-or-redirect shape: a
 * segment that resolves through `parseSettingsTab` opens the overlay on it,
 * then bounces to the project home behind it — `ProjectShell` mounts
 * `SettingsPanel` persistently, so this route's only job is to set store
 * state and leave. A segment that is not a live tab but IS a known legacy id
 * (a renamed tab, or a section that graduated to its own page) goes through
 * `legacySectionRedirect` — the same resolution `/customize/[section]` uses —
 * so e.g. a bookmarked `/settings/computers` lands on the Connectors page
 * that owns computers now instead of silently opening the default tab.
 * Anything else (a typo, a truly dead id) falls back to the bare
 * `/projects/[id]/settings` route rather than opening on a tab that doesn't
 * exist.
 *
 * This page used to render `SettingsPanel` directly, because nothing else
 * mounted it yet. Now that `ProjectShell` does, rendering it here too would
 * stack a second full-viewport `Modal` on the same store — and closing the
 * overlay from THIS route used to leave a blank page, since nothing else was
 * ever rendered here. Redirecting away fixes both.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import {
  legacySectionRedirect,
  parseSettingsTab,
} from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

export default function ProjectSettingsTabPage() {
  const params = useParams<{ id: string; tab: string }>();
  const projectId = params?.id ?? '';
  const tab = parseSettingsTab(params?.tab);
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    if (!tab) {
      // `legacySectionRedirect` never returns this same URL for an
      // unparseable segment: it resolves only known legacy ids, and every
      // rename target is a live tab, so the redirect cannot loop back here.
      router.replace(
        legacySectionRedirect(projectId, params?.tab) ?? `/projects/${projectId}/settings`,
      );
      return;
    }
    useSettingsPanelStore.getState().openSettings(tab);
    router.replace(`/projects/${projectId}`);
  }, [projectId, tab, params?.tab, router]);

  return null;
}
