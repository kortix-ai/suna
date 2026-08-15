'use client';

/**
 * /projects/[id]/customize — opens the Customize panel on its default pane,
 * or on the pane named by the legacy `?section=` query the old overlay used.
 * See `panel-deep-link.tsx`.
 */

import { PanelDeepLink } from '@/features/workspace/settings/panel-deep-link';

export default function ProjectCustomizePage() {
  return <PanelDeepLink fallbackSurface="customize" />;
}
