'use client';

/**
 * /projects/[id]/settings — opens the Settings panel on its default pane.
 * See `panel-deep-link.tsx`.
 */

import { PanelDeepLink } from '@/features/workspace/settings/panel-deep-link';

export default function ProjectSettingsPage() {
  return <PanelDeepLink fallbackSurface="settings" />;
}
