'use client';

/**
 * /projects/[id]/settings/[tab] — the canonical deep link into a Settings
 * pane (e.g. `/settings/members`).
 *
 * A segment that names a Customize pane opens Customize instead — the tab owns
 * its surface, not the URL, so a bookmarked `/settings/secrets` still lands on
 * Secrets after it moved. See `panel-deep-link.tsx`.
 */

import { useParams } from 'next/navigation';

import { PanelDeepLink } from '@/features/workspace/settings/panel-deep-link';

export default function ProjectSettingsTabPage() {
  const params = useParams<{ tab: string }>();
  return <PanelDeepLink segment={params?.tab} fallbackSurface="settings" />;
}
