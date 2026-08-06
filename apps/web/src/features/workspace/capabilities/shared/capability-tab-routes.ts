/**
 * The capability pages that graduated out of the Customize overlay. Commands
 * was removed (its standalone page deleted) and lives only in the Customize
 * overlay again — `/customize/commands` via the `proj-commands` palette entry.
 * Order is the tab order; it is also the order the sidebar lists them in.
 */
export interface CapabilityTab {
  key: 'connectors' | 'skills';
  label: string;
}

export const CAPABILITY_TABS: readonly CapabilityTab[] = [
  { key: 'connectors', label: 'Connectors' },
  { key: 'skills', label: 'Skills' },
];

export function capabilityTabHref(projectId: string, key: CapabilityTab['key']): string {
  return `/projects/${projectId}/${key}`;
}

export function activeCapabilityTab(pathname: string): CapabilityTab['key'] | null {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const hit = CAPABILITY_TABS.find((t) => t.key === last);
  return hit ? hit.key : null;
}
