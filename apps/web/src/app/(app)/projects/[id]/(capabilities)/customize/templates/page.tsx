'use client';

import { useParams } from 'next/navigation';

import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';
import { useCapabilityTabFlag } from '@/features/workspace/capabilities/shared/use-capability-tab-flag';
import { TemplatesStore } from '@/features/templates/templates-store';

/**
 * `/projects/[id]/customize/templates` — the Templates capability tab.
 *
 * A `(capabilities)` route, so it renders under the shared tab bar beside
 * Agents / Skills / Connectors / Triggers / Review / Models / Secrets /
 * Settings. It is one of two flag-gated tabs: `CAPABILITY_TABS` marks it
 * `flag: 'templates'`, so the tab disappears when the project has that flag
 * off (`visibleCapabilityTabs` in `capability-tabs.tsx`) and
 * `useCapabilityTabFlag` 404s this route for anyone who types the URL. Both
 * gates read that one `flag:` field, so they cannot drift.
 *
 * The route USED to render unconditionally, on the reasoning that the API
 * already answers `403 feature_disabled` for the install. That gate is real but
 * it is the wrong one to rely on: the catalog itself is public and unflagged,
 * so the page painted six installable-looking cards for a project that has no
 * Templates tab, and only the Install click failed.
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
  const enabled = useCapabilityTabFlag(projectId, 'templates');

  if (!enabled) return <CapabilitiesSkeleton />;

  return <TemplatesStore projectId={projectId} />;
}
