'use client';

import { useParams } from 'next/navigation';

import { SubprojectsStore } from '@/features/subprojects/subprojects-store';

/**
 * `/projects/[id]/customize/marketplace` — the Marketplace capability tab.
 *
 * A `(capabilities)` route, so it renders under the shared tab bar beside
 * Agents / Skills / Connectors / Triggers / Review / Models / Secrets /
 * Settings. It is one of two flag-gated tabs: `CAPABILITY_TABS` marks it
 * `flag: 'subprojects'`, so the tab disappears when the project has that flag
 * off (`visibleCapabilityTabs` in `capability-tabs.tsx`). This ROUTE is
 * deliberately not flag-gated on the client — the API already answers `403
 * feature_disabled` for every subproject read, so a person who types the URL
 * gets the store's own error state rather than a second, client-side copy of
 * the same gate that could drift from it.
 *
 * `SubprojectsStore` renders directly, NOT through `CapabilityPageShell`,
 * unlike Agents/Connectors/Skills. The shell puts search and filters ABOVE its
 * children; this page's first section is the project's own installed
 * subprojects, and a search box sitting above that list while filtering only
 * the catalog below it is a control that appears to do something it does not.
 * The store therefore keeps its own header, and matches the shell's container
 * and type tokens instead of borrowing its markup.
 *
 * No deeper routes live under this segment. `activeCapabilityTab` matches
 * exactly four path segments (`/projects/<id>/customize/marketplace`), so a
 * `/marketplace/<anything>` page would un-highlight both this tab and the
 * sidebar's Customize row while open.
 */
export default function ProjectMarketplacePage() {
  const { id: projectId } = useParams<{ id: string }>();

  return <SubprojectsStore projectId={projectId} />;
}
