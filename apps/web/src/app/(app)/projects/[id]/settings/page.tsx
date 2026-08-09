'use client';

/**
 * /projects/[id]/settings — deep-link entry into the merged Settings overlay
 * (see `features/workspace/settings/settings-panel.tsx`), opened on its
 * default tab.
 *
 * Mirrors `customize/page.tsx`'s "set store state, then `router.replace` away
 * to a real destination" shape. That used to NOT be true here: this page
 * used to render `SettingsPanel` directly, because the panel wasn't mounted
 * anywhere else yet. Now that `ProjectShell` mounts `SettingsPanel`
 * persistently (see the settings-panel plan, Task 5b), rendering it a SECOND
 * time here would stack two full-viewport `Modal`s on the same store. This
 * page's only job is to set state and bounce to a page that actually renders
 * something — closing the overlay from here now lands on the project home
 * behind it, not a blank page.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { DEFAULT_SETTINGS_TAB } from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    useSettingsPanelStore.getState().openSettings(DEFAULT_SETTINGS_TAB);
    router.replace(`/projects/${projectId}`);
  }, [projectId, router]);

  return null;
}
