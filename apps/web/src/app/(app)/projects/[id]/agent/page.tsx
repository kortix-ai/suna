'use client';

/**
 * /projects/[id]/agent — the old standalone agents page. Agents are a
 * Customize pane now; this route stays so bookmarks and stale links open the
 * panel on that pane instead of 404ing. See `panel-deep-link.tsx`.
 */

import { PanelDeepLink } from '@/features/workspace/settings/panel-deep-link';

export default function ProjectAgentsRouteRedirect() {
  return <PanelDeepLink segment="agents" fallbackSurface="customize" />;
}
