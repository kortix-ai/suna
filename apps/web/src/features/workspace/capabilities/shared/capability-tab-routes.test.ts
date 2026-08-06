import { describe, expect, test } from 'bun:test';
import { CAPABILITY_TABS, activeCapabilityTab, capabilityTabHref } from './capability-tab-routes';

describe('CAPABILITY_TABS', () => {
  test('lists connectors, skills in that order', () => {
    expect(CAPABILITY_TABS.map((t) => t.key)).toEqual(['connectors', 'skills']);
  });
});

describe('capabilityTabHref', () => {
  test('builds a project-scoped path to wherever the section currently lives', () => {
    // Flag-dependent since #6054 was put behind NEXT_PUBLIC_CAPABILITY_PAGES:
    // this is the one choke point the sidebar, the tab strip and project home
    // all use, so it points at the overlay while the pages are hidden.
    const previous = process.env.NEXT_PUBLIC_CAPABILITY_PAGES;
    try {
      process.env.NEXT_PUBLIC_CAPABILITY_PAGES = 'true';
      expect(capabilityTabHref('p1', 'skills')).toBe('/projects/p1/skills');
      process.env.NEXT_PUBLIC_CAPABILITY_PAGES = 'false';
      expect(capabilityTabHref('p1', 'skills')).toBe('/projects/p1/customize/skills');
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_CAPABILITY_PAGES;
      else process.env.NEXT_PUBLIC_CAPABILITY_PAGES = previous;
    }
  });
});

describe('activeCapabilityTab', () => {
  test('matches the tab segment', () => {
    expect(activeCapabilityTab('/projects/p1/connectors')).toBe('connectors');
    expect(activeCapabilityTab('/projects/p1/skills')).toBe('skills');
  });
  test('ignores trailing segments', () => {
    expect(activeCapabilityTab('/projects/p1/skills/')).toBe('skills');
  });
  test('returns null off the capability routes', () => {
    expect(activeCapabilityTab('/projects/p1/files')).toBeNull();
    expect(activeCapabilityTab('/projects/p1')).toBeNull();
  });
});
