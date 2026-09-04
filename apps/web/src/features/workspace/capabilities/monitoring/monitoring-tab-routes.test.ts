import { describe, expect, test } from 'bun:test';

import { MONITORING_TABS, activeMonitoringTab, monitoringTabHref } from './monitoring-tab-routes';

describe('monitoring tabs', () => {
  test('board leads and is the landing tab; runs is its own route', () => {
    expect(MONITORING_TABS.map((t) => t.key)).toEqual(['board', 'runs']);
    expect(monitoringTabHref('p1', 'board')).toBe('/projects/p1/monitoring');
    expect(monitoringTabHref('p1', 'runs')).toBe('/projects/p1/monitoring/runs');
  });

  test('activeMonitoringTab matches the exact shapes the hrefs build', () => {
    expect(activeMonitoringTab('/projects/p1/monitoring')).toBe('board');
    expect(activeMonitoringTab('/projects/p1/monitoring/')).toBe('board');
    expect(activeMonitoringTab('/projects/p1/monitoring/runs')).toBe('runs');
    // Not this group: a deeper path, another segment, another route family.
    expect(activeMonitoringTab('/projects/p1/monitoring/runs/x')).toBeNull();
    expect(activeMonitoringTab('/projects/p1/monitoring/other')).toBeNull();
    expect(activeMonitoringTab('/projects/p1/customize/triggers')).toBeNull();
    expect(activeMonitoringTab('/monitoring')).toBeNull();
  });
});
