'use client';

/**
 * /projects/[id]/settings — entry point into the merged Settings overlay
 * (see `features/workspace/settings/settings-panel.tsx`), opened on its
 * default tab.
 *
 * This does NOT follow `customize/page.tsx`'s "set store state, then
 * `router.replace` away to a real destination" shape, and that's a
 * deliberate departure worth calling out: `CustomizePanel` works that way
 * because it's mounted once, persistently, in the project layout — any
 * route under `/projects/[id]/*` already has it behind it, so the redirect
 * page's only job is to set state and bounce to a page that actually
 * renders something. `SettingsPanel` isn't mounted anywhere else yet (that
 * lands in Task 5b, alongside deleting `CustomizePanel`) — so if this page
 * bounced away without rendering it, nothing would ever show. Until then,
 * this route (and its `[tab]` sibling, and the projectless `/settings/[tab]`
 * route) IS the mount point: it renders `SettingsPanel` directly so a direct
 * link or a reload actually shows the overlay.
 */

import { useEffect } from 'react';
import { useParams } from 'next/navigation';

import { SettingsPanel } from '@/features/workspace/settings/settings-panel';
import { DEFAULT_SETTINGS_TAB } from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';

  useEffect(() => {
    if (!projectId) return;
    useSettingsPanelStore.getState().openSettings(DEFAULT_SETTINGS_TAB);
  }, [projectId]);

  if (!projectId) return null;
  return <SettingsPanel projectId={projectId} />;
}
