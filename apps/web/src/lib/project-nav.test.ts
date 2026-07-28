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
  test('every section resolves', () => {
    // The guarantee: a section without a home fails here rather than silently
    // becoming unreachable, which is how Computers was lost.
    for (const section of CUSTOMIZE_SECTIONS) {
      expect(resolveLegacyCustomizeHref(P, section)).not.toBeNull();
    }
  });

  test('every section resolves into the one Customize surface', () => {
    for (const section of CUSTOMIZE_SECTIONS) {
      expect(resolveLegacyCustomizeHref(P, section)).toStartWith(`/projects/${P}/customize/`);
    }
  });

  test('each section gets its own distinct href', () => {
    const hrefs = CUSTOMIZE_SECTIONS.map((s) => resolveLegacyCustomizeHref(P, s));
    expect(new Set(hrefs).size).toBe(CUSTOMIZE_SECTIONS.length);
  });

  test('no href carries a query param nothing reads', () => {
    // `?group=channels` resolved to a param connectors-view never read, so
    // three sections silently landed on the wrong screen.
    for (const section of CUSTOMIZE_SECTIONS) {
      expect(resolveLegacyCustomizeHref(P, section)).not.toContain('group=');
    }
  });
});

describe('resolveLegacyCustomizeHref — section mapping', () => {
  const at = (section: string) => resolveLegacyCustomizeHref(P, section);

  test('a section is named by its own segment', () => {
    expect(at('agents')).toBe(`/projects/${P}/customize/agents`);
    expect(at('connectors')).toBe(`/projects/${P}/customize/connectors`);
    expect(at('settings')).toBe(`/projects/${P}/customize/settings`);
  });

  test('sections that were folded away have their own home again', () => {
    for (const section of ['channels', 'computers', 'voice', 'commands', 'git']) {
      expect(at(section)).toBe(`/projects/${P}/customize/${section}`);
    }
  });

  test('schedules and webhooks stay distinct sections', () => {
    expect(at('schedules')).toBe(`/projects/${P}/customize/schedules`);
    expect(at('webhooks')).toBe(`/projects/${P}/customize/webhooks`);
  });

  test('every llm section keeps its own href', () => {
    const llm = CUSTOMIZE_SECTIONS.filter((s) => s.startsWith('llm-'));
    expect(llm.length).toBeGreaterThan(0);
    for (const section of llm) {
      expect(at(section)).toBe(`/projects/${P}/customize/${section}`);
    }
  });
});

describe('resolveLegacyCustomizeHref — sub-state', () => {
  test('carries the members invite tab across', () => {
    expect(resolveLegacyCustomizeHref(P, 'members', { membersTab: 'invite' })).toBe(
      `/projects/${P}/customize/members?tab=invite`,
    );
  });

  test('ignores a members tab that is not invite', () => {
    expect(resolveLegacyCustomizeHref(P, 'members', { membersTab: 'list' })).toBe(
      `/projects/${P}/customize/members`,
    );
  });

  test('options on an unrelated section change nothing', () => {
    expect(resolveLegacyCustomizeHref(P, 'agents', { membersTab: 'invite' })).toBe(
      `/projects/${P}/customize/agents`,
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
