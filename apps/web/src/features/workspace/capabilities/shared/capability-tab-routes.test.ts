import { describe, expect, test } from 'bun:test';
import { CAPABILITY_TABS, activeCapabilityTab, capabilityTabHref } from './capability-tab-routes';

describe('CAPABILITY_TABS', () => {
  test('lists connectors, agent, skills in that order', () => {
    expect(CAPABILITY_TABS.map((t) => t.key)).toEqual(['connectors', 'agent', 'skills']);
  });

  test('the Agents tab keeps a singular key and a plural label', () => {
    // The key IS the URL segment (`/projects/<id>/agent`); pluralizing it here
    // would 404 the route while the tab still rendered.
    const agents = CAPABILITY_TABS.find((t) => t.label === 'Agents');
    expect(agents?.key).toBe('agent');
  });
});

describe('capabilityTabHref', () => {
  test('builds a workspace-scoped path', () => {
    expect(capabilityTabHref('p1', 'skills')).toBe('/workspaces/p1/skills');
    expect(capabilityTabHref('p1', 'agent')).toBe('/workspaces/p1/agent');
  });
});

describe('activeCapabilityTab', () => {
  test('matches the tab segment', () => {
    expect(activeCapabilityTab('/projects/p1/agent')).toBe('agent');
    expect(activeCapabilityTab('/projects/p1/connectors')).toBe('connectors');
    expect(activeCapabilityTab('/projects/p1/skills')).toBe('skills');
  });
  test('ignores trailing segments', () => {
    expect(activeCapabilityTab('/projects/p1/skills/')).toBe('skills');
    expect(activeCapabilityTab('/projects/p1/agent/')).toBe('agent');
  });
  test('returns null off the capability routes', () => {
    expect(activeCapabilityTab('/projects/p1/files')).toBeNull();
    expect(activeCapabilityTab('/projects/p1')).toBeNull();
    // `agents` is the OLD Customize section name, not this route.
    expect(activeCapabilityTab('/projects/p1/agents')).toBeNull();
  });
});
