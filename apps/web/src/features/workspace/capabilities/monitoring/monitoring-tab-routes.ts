/**
 * The two Monitoring tabs, as pure data — the same shape as
 * `shared/capability-tab-routes.ts`, and for the same reason: this module is
 * imported by server route files, so no icons and no React here.
 *
 * Route-based, like the Customize bar: `/projects/<id>/monitoring` is the
 * board (the landing tab, no segment), `/projects/<id>/monitoring/runs` the
 * trigger runs. A tab is a URL a person can be sent to, not a query param.
 */
export interface MonitoringTab {
  key: 'board' | 'runs';
  label: string;
}

export const MONITORING_TABS: readonly MonitoringTab[] = [
  { key: 'board', label: 'Stage board' },
  { key: 'runs', label: 'Trigger runs' },
];

export function monitoringHref(projectId: string): string {
  return `/projects/${projectId}/monitoring`;
}

export function monitoringTabHref(projectId: string, key: MonitoringTab['key']): string {
  return key === 'board' ? monitoringHref(projectId) : `${monitoringHref(projectId)}/runs`;
}

/**
 * The tab a pathname is on, matched against the exact shapes
 * `monitoringTabHref` builds. Shape-checked like `activeCapabilityTab`, so a
 * `/monitoring` segment elsewhere in the app never lights a tab here.
 */
export function activeMonitoringTab(pathname: string): MonitoringTab['key'] | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'projects' || segments[2] !== 'monitoring') return null;
  if (segments.length === 3) return 'board';
  if (segments.length === 4 && segments[3] === 'runs') return 'runs';
  return null;
}
