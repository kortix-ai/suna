'use client';

/**
 * /projects/[id]/skills — the old standalone skills page. It is a
 * Customize pane now; this route stays so bookmarks and stale links open the
 * panel on that pane instead of 404ing. See `panel-deep-link.tsx`.
 */

import { PanelDeepLink } from '@/features/workspace/settings/panel-deep-link';

export default function ProjectSkillsRouteRedirect() {
  return <PanelDeepLink segment="skills" fallbackSurface="customize" />;
}
