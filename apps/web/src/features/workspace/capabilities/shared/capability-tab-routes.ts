import { capabilitySectionHref } from '@/lib/capability-pages';

/**
 * The three capability pages that graduated out of the Customize overlay.
 * Order is the tab order; it is also the order the sidebar lists them in.
 */
export interface CapabilityTab {
  key: 'connectors' | 'skills' | 'commands';
  label: string;
}

export const CAPABILITY_TABS: readonly CapabilityTab[] = [
  { key: 'connectors', label: 'Connectors' },
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Commands' },
];

/**
 * Where a capability tab points.
 *
 * The single choke point for the sidebar, the tab strip and project home, so
 * gating it here is what stops the product linking anyone into the standalone
 * pages while they are flagged off (#6054). With the flag off the same click
 * opens the Customize overlay on that section instead — the surface those
 * pages replaced.
 */
export function capabilityTabHref(projectId: string, key: CapabilityTab['key']): string {
  return capabilitySectionHref(projectId, key);
}

export function activeCapabilityTab(pathname: string): CapabilityTab['key'] | null {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const hit = CAPABILITY_TABS.find((t) => t.key === last);
  return hit ? hit.key : null;
}
