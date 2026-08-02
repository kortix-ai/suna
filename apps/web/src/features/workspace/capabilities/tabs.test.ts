import { describe, expect, test } from 'bun:test';
import { CAPABILITY_TABS, activeCapabilityTab, capabilityTabHref } from './tabs';

describe('CAPABILITY_TABS', () => {
  test('lists connectors, skills, commands in that order', () => {
    expect(CAPABILITY_TABS.map((t) => t.key)).toEqual(['connectors', 'skills', 'commands']);
  });
});

describe('capabilityTabHref', () => {
  test('builds a project-scoped path', () => {
    expect(capabilityTabHref('p1', 'skills')).toBe('/projects/p1/skills');
  });
});

describe('activeCapabilityTab', () => {
  test('matches the tab segment', () => {
    expect(activeCapabilityTab('/projects/p1/connectors')).toBe('connectors');
    expect(activeCapabilityTab('/projects/p1/commands')).toBe('commands');
  });
  test('ignores trailing segments', () => {
    expect(activeCapabilityTab('/projects/p1/skills/')).toBe('skills');
  });
  test('returns null off the capability routes', () => {
    expect(activeCapabilityTab('/projects/p1/files')).toBeNull();
    expect(activeCapabilityTab('/projects/p1')).toBeNull();
  });
});
