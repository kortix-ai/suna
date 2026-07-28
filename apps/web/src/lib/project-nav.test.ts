import { describe, expect, test } from 'bun:test';

import { CUSTOMIZE_SECTIONS } from './customize-sections';
import {
  PROJECT_NAV_ITEMS,
  PROJECT_ROUTE_SEGMENTS,
  PROJECT_SETTINGS_TABS,
  projectNavHref,
  projectSettingsHref,
  resolveLegacyCustomizeHref,
} from './project-nav';

const P = 'proj-1';

describe('the four nav items', () => {
  test('is exactly Connectors, Skills, Automations, Agents, in order', () => {
    expect(PROJECT_NAV_ITEMS.map((i) => i.label)).toEqual([
      'Connectors',
      'Skills',
      'Automations',
      'Agents',
    ]);
  });

  test('every item gates on a real customize section so IAM is unchanged', () => {
    for (const item of PROJECT_NAV_ITEMS) {
      expect(CUSTOMIZE_SECTIONS).toContain(item.gateSection);
    }
  });

  test('builds hrefs under the project', () => {
    expect(projectNavHref(P, 'automations')).toBe('/projects/proj-1/automations');
    expect(projectNavHref(P, 'connectors')).toBe('/projects/proj-1/connectors');
  });
});

describe('settings tabs', () => {
  test('every tab gates on a real customize section', () => {
    for (const tab of PROJECT_SETTINGS_TABS) {
      expect(CUSTOMIZE_SECTIONS).toContain(tab.gateSection);
    }
  });

  test('tab keys are unique', () => {
    const keys = PROJECT_SETTINGS_TABS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('builds hrefs under the project', () => {
    expect(projectSettingsHref(P, 'members')).toBe('/projects/proj-1/settings/members');
  });
});

describe('resolveLegacyCustomizeHref — no functionality removed', () => {
  /**
   * The guarantee for the whole migration. Customize had 24 sections; if a new
   * one is added, or an existing one loses its home, this fails.
   */
  test('every one of the 24 legacy sections resolves to a route', () => {
    const orphans = CUSTOMIZE_SECTIONS.filter((s) => resolveLegacyCustomizeHref(P, s) === null);
    expect(orphans).toEqual([]);
  });

  test('every resolved route starts with the project and a known segment', () => {
    const prefix = `/projects/${P}/`;
    for (const section of CUSTOMIZE_SECTIONS) {
      const href = resolveLegacyCustomizeHref(P, section) ?? '';
      expect(href).toStartWith(prefix);
      const segment = href.slice(prefix.length).split(/[?/]/)[0];
      expect(PROJECT_ROUTE_SEGMENTS).toContain(segment);
    }
  });

  test('no resolved route still points at the overlay', () => {
    for (const section of CUSTOMIZE_SECTIONS) {
      expect(resolveLegacyCustomizeHref(P, section)).not.toContain('customize');
    }
  });
});

describe('resolveLegacyCustomizeHref — section mapping', () => {
  const at = (section: string) => resolveLegacyCustomizeHref(P, section);

  test('the four promoted sections land on their own routes', () => {
    expect(at('connectors')).toBe('/projects/proj-1/connectors');
    expect(at('skills')).toBe('/projects/proj-1/skills');
    expect(at('agents')).toBe('/projects/proj-1/agents');
    expect(at('schedules')).toBe('/projects/proj-1/automations');
  });

  test('commands become a Skills tab, restoring a section that renders nothing today', () => {
    expect(at('commands')).toBe('/projects/proj-1/skills?tab=commands');
  });

  test('webhooks share the Automations page behind a filter', () => {
    expect(at('webhooks')).toBe('/projects/proj-1/automations?type=webhook');
  });

  test('channels, computers and voice fold into Connectors', () => {
    expect(at('channels')).toBe('/projects/proj-1/connectors?group=channels');
    expect(at('computers')).toBe('/projects/proj-1/connectors?group=computers');
    expect(at('voice')).toStartWith('/projects/proj-1/connectors?group=channels');
  });

  test('config sections become Settings tabs', () => {
    expect(at('settings')).toBe('/projects/proj-1/settings/general');
    expect(at('members')).toBe('/projects/proj-1/settings/members');
    expect(at('secrets')).toBe('/projects/proj-1/settings/environment');
    expect(at('git')).toBe('/projects/proj-1/settings/repository');
    expect(at('sandbox')).toBe('/projects/proj-1/settings/sandbox');
    expect(at('upgrade')).toBe('/projects/proj-1/settings/upgrades');
  });

  test('all seven llm sections collapse onto the Models tab', () => {
    expect(at('llm-management')).toBe('/projects/proj-1/settings/models');
    expect(at('llm-overview')).toBe('/projects/proj-1/settings/models?llm=overview');
    expect(at('llm-providers')).toBe('/projects/proj-1/settings/models?llm=providers');
    expect(at('llm-logs')).toBe('/projects/proj-1/settings/models?llm=logs');
    expect(at('llm-budgets')).toBe('/projects/proj-1/settings/models?llm=budgets');
    expect(at('llm-keys')).toBe('/projects/proj-1/settings/models?llm=keys');
    expect(at('llm-api')).toBe('/projects/proj-1/settings/models?llm=api');
  });

  test('marketplace and review get their own routes, not Settings', () => {
    expect(at('marketplace')).toBe('/projects/proj-1/marketplace');
    expect(at('review')).toBe('/projects/proj-1/review');
    expect(at('marketplace')).not.toContain('/settings/');
    expect(at('review')).not.toContain('/settings/');
  });
});

describe('resolveLegacyCustomizeHref — sub-state', () => {
  test('carries the members invite tab across', () => {
    expect(resolveLegacyCustomizeHref(P, 'members', { membersTab: 'invite' })).toBe(
      '/projects/proj-1/settings/members?tab=invite',
    );
  });

  test('ignores a members tab that is not invite', () => {
    expect(resolveLegacyCustomizeHref(P, 'members', { membersTab: 'roster' })).toBe(
      '/projects/proj-1/settings/members',
    );
    expect(resolveLegacyCustomizeHref(P, 'members', { membersTab: null })).toBe(
      '/projects/proj-1/settings/members',
    );
  });

  test('options on an unrelated section change nothing', () => {
    expect(resolveLegacyCustomizeHref(P, 'agents', { membersTab: 'invite' })).toBe(
      '/projects/proj-1/agents',
    );
  });
});

describe('resolveLegacyCustomizeHref — files and unknowns', () => {
  test('files and changes still redirect to the standalone Files page', () => {
    expect(resolveLegacyCustomizeHref(P, 'files')).toBe('/projects/proj-1/files');
    expect(resolveLegacyCustomizeHref(P, 'changes')).toBe(
      '/projects/proj-1/files?panel=proposed-changes',
    );
  });

  test('returns null for absent or unknown input so callers can default', () => {
    expect(resolveLegacyCustomizeHref(P, null)).toBeNull();
    expect(resolveLegacyCustomizeHref(P, undefined)).toBeNull();
    expect(resolveLegacyCustomizeHref(P, '')).toBeNull();
    expect(resolveLegacyCustomizeHref(P, 'not-a-section')).toBeNull();
  });

  test('does not treat an unknown section as a path', () => {
    // A crafted section must never escape the project scope.
    expect(resolveLegacyCustomizeHref(P, '../admin')).toBeNull();
    expect(resolveLegacyCustomizeHref(P, '//evil.com')).toBeNull();
  });
});
