'use client';

/**
 * Deep-link entry into the Customize / Settings panels.
 *
 * Neither panel is a route — `ProjectShell` mounts `SettingsPanel`
 * persistently and it floats over whatever project page is active. So every
 * URL that names a pane does exactly two things: set the store state, then
 * leave. That is this component. It backs five routes:
 *
 *   /projects/[id]/customize(/<tab>)   /projects/[id]/settings(/<tab>)
 *   /projects/[id]/agent   /projects/[id]/skills   /projects/[id]/connectors
 *   /projects/[id]/apps
 *
 * The last four are the old standalone capability pages. They are Customize
 * panes now, and the routes stay only so bookmarks, `<Link>`s in the wild, and
 * the command palette's stored hrefs keep working.
 *
 * Resolution is deliberately forgiving, in this order:
 *  1. the path segment, through `legacySectionRedirect`, which folds every
 *     renamed id (`git` → `repositories`, `agent` → `agents`, every `llm-*` →
 *     `models`, …) and every non-pane route (`files`, `changes`) onto its home;
 *  2. the legacy `?section=` query the old Customize overlay used;
 *  3. nothing — open the panel named by the route on its own default tab.
 *
 * A resolved tab opens on the surface that OWNS it, never on the surface in
 * the URL: `/settings/secrets` opens Customize, because Secrets moved there.
 * That is why this takes `fallbackSurface` rather than a surface — the URL
 * only decides which panel to open when it names no tab at all.
 */

import { Suspense, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import {
  legacySectionRedirect,
  parseSettingsTab,
  type SettingsSurface,
  type SettingsTab,
} from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

/** The tab a `/…/<segment>` deep link resolves to, or null for "no tab". */
export function resolveDeepLinkTab(
  projectId: string,
  segment: string | null | undefined,
): { tab: SettingsTab } | { route: string } | null {
  const resolved = legacySectionRedirect(projectId, segment);
  if (!resolved) return null;
  const last = resolved.split('?')[0].split('/').pop();
  const tab = parseSettingsTab(last);
  // `legacySectionRedirect` resolves `files` / `changes` to real routes, not
  // panes. Those must navigate, not open a panel.
  return tab ? { tab } : { route: resolved };
}

export interface PanelDeepLinkProps {
  /** The path segment naming a pane, when the route has one. */
  segment?: string;
  /** Which panel a URL that names no pane opens. */
  fallbackSurface: SettingsSurface;
}

/**
 * The `Suspense` boundary is required, not decorative: the body reads
 * `useSearchParams()` for the legacy `?section=` leg, and Next refuses to
 * prerender a route that does so unbounded. The fallback is `null` because
 * this component renders nothing in the first place — it redirects.
 */
export function PanelDeepLink(props: PanelDeepLinkProps) {
  return (
    <Suspense fallback={null}>
      <PanelDeepLinkBody {...props} />
    </Suspense>
  );
}

function PanelDeepLinkBody({ segment, fallbackSurface }: PanelDeepLinkProps) {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    const hit =
      resolveDeepLinkTab(projectId, segment) ??
      resolveDeepLinkTab(projectId, searchParams.get('section'));

    if (hit && 'route' in hit) {
      router.replace(hit.route);
      return;
    }

    const { openCustomize, openSettings } = useSettingsPanelStore.getState();
    const open = fallbackSurface === 'customize' ? openCustomize : openSettings;
    open(hit?.tab);
    router.replace(`/projects/${projectId}`);
  }, [projectId, segment, searchParams, router, fallbackSurface]);

  return null;
}
