/**
 * The capability pages that graduated out of the Customize overlay. Commands
 * was removed (its standalone page deleted) and lives only in the Customize
 * overlay again — `/customize/commands` via the `workspace-commands` palette entry.
 * Order is the tab order; it is also the order the sidebar lists them in.
 */
export interface CapabilityTab {
  key: 'agent' | 'connectors' | 'skills';
  label: string;
}

/**
 * This array is the tab order, the sidebar order, and — via the first entry
 * the caller may read — the landing tab. `TAB_PREFERENCE` in
 * `workspace-sidebar/workspace-settings-nav.tsx` mirrors it and is asserted
 * against it, so reordering here moves the landing tab too.
 *
 * The Agents key is singular because a key IS its URL segment
 * (`/projects/<id>/agent`); only the label is plural.
 */
export const CAPABILITY_TABS: readonly CapabilityTab[] = [
  { key: 'connectors', label: 'Connectors' },
  { key: 'agent', label: 'Agents' },
  { key: 'skills', label: 'Skills' },
];

export function capabilityTabHref(workspaceId: string, key: CapabilityTab['key']): string {
  return `/workspaces/${workspaceId}/${key}`;
}

export function activeCapabilityTab(pathname: string): CapabilityTab['key'] | null {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const hit = CAPABILITY_TABS.find((t) => t.key === last);
  return hit ? hit.key : null;
}
