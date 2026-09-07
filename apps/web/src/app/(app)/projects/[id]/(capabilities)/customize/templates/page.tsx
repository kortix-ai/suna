'use client';

import { useParams } from 'next/navigation';

import { TemplatesStore } from '@/features/templates/templates-store';

/**
 * `/projects/[id]/customize/templates` — the Templates capability tab.
 *
 * A `(capabilities)` route, so it renders under the shared tab bar beside
 * Agents / Skills / Connectors / Triggers / Review / Models / Secrets /
 * Settings. It is one of two flag-gated tabs: `CAPABILITY_TABS` marks it
 * `flag: 'templates'`, so the tab disappears when the project has that flag
 * off (`visibleCapabilityTabs` in `capability-tabs.tsx`). This ROUTE is
 * deliberately not flag-gated on the client — the API already answers `403
 * feature_disabled` for the install, so a person who types the URL gets the
 * store rather than a second, client-side copy of the same gate that could
 * drift from it.
 *
 * `TemplatesStore` renders directly, NOT through `CapabilityPageShell`,
 * unlike Agents/Connectors/Skills: the store keeps its own header and matches
 * the shell's container and type tokens instead of borrowing its markup.
 *
 * No deeper routes live under this segment. `activeCapabilityTab` matches
 * exactly four path segments (`/projects/<id>/customize/templates`), so a
 * `/templates/<anything>` page would un-highlight both this tab and the
 * sidebar's Customize row while open.
 */
export default function ProjectTemplatesPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return <TemplatesStore projectId={projectId} />;
}
