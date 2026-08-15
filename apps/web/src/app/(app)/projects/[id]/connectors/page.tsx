'use client';

/**
 * /projects/[id]/connectors — the old standalone connectors page. It is a
 * Customize pane now; this route stays so bookmarks and stale links open the
 * panel on that pane instead of 404ing. See `panel-deep-link.tsx`.
 */

import { PanelDeepLink } from '@/features/workspace/settings/panel-deep-link';

export default function ProjectConnectorsRouteRedirect() {
  return <PanelDeepLink segment="connectors" fallbackSurface="customize" />;
}
