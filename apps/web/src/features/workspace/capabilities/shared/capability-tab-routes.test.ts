import { describe, expect, test } from 'bun:test';
import {
  CAPABILITY_TABS,
  activeCapabilityTab,
  capabilityTabHref,
  channelsHref,
} from './capability-tab-routes';

describe('CAPABILITY_TABS', () => {
  test('lists models, connectors, agent, skills, triggers, marketplace, secrets, config in that order', () => {
    // Models leads the bar (Jay, 2026-08-17) — it used to sit after Triggers.
    // Marketplace sits after Triggers and before Secrets: the five before it
    // are what a project declares, and Marketplace installs a ready-made set
    // of exactly those five. Secrets and Settings are the operator half.
    expect(CAPABILITY_TABS.map((t) => t.key)).toEqual([
      'models',
      'connectors',
      'agent',
      'skills',
      'triggers',
      'marketplace',
      'secrets',
      'config',
    ]);
  });

  // Marketplace is the only tab whose surface a project can be without. The
  // flag lives HERE, on the tab record, rather than in the bar component, so
  // the bar, the sidebar row and the Customize index card all read one answer.
  // `capability-tabs-gating.test.ts` asserts what the flag does; this asserts
  // the tab declares it at all.
  test('Marketplace is the one flag-gated tab, on the `subprojects` flag', () => {
    expect(CAPABILITY_TABS.filter((t) => t.flag).map((t) => [t.key, t.flag])).toEqual([
      ['marketplace', 'subprojects'],
    ]);
  });

  test('Channels is not a tab — it is a scope of Connectors', () => {
    // It was one, briefly. Asserted absent rather than merely left out of the
    // list above, so re-adding the key without re-adding a route fails here
    // instead of shipping a tab that 404s.
    expect(CAPABILITY_TABS.map((t) => t.key)).not.toContain('channels');
    expect(CAPABILITY_TABS.map((t) => t.label)).not.toContain('Channels');
  });

  test('channelsHref names the Connectors page and the scope that shows Channels', () => {
    // The one URL. `/projects/<id>/channels` redirects to it, `GRADUATED`
    // points at it, and the project-home Slack tile opens it — all through
    // this function, so none of them can drift from the param the page parses.
    expect(channelsHref('p1')).toBe('/projects/p1/connectors?scope=channels');
  });

  test('the Settings tab keys on `config`, never on `settings`', () => {
    // `/projects/<id>/settings` is the settings OVERLAY's deep-link route. Two
    // routes cannot share one segment, so the tab that holds project
    // configuration takes `config` and keeps the label a person reads.
    const settings = CAPABILITY_TABS.find((t) => t.label === 'Settings');
    expect(settings?.key).toBe('config');
    expect(CAPABILITY_TABS.map((t) => t.key)).not.toContain('settings');
  });

  test('the Agents tab keeps a singular key and a plural label', () => {
    // The key IS the URL segment (`/projects/<id>/agent`); pluralizing it here
    // would 404 the route while the tab still rendered.
    const agents = CAPABILITY_TABS.find((t) => t.label === 'Agents');
    expect(agents?.key).toBe('agent');
  });
});

describe('capabilityTabHref', () => {
  test('builds a project-scoped path', () => {
    expect(capabilityTabHref('p1', 'skills')).toBe('/projects/p1/skills');
    expect(capabilityTabHref('p1', 'agent')).toBe('/projects/p1/agent');
    expect(capabilityTabHref('p1', 'triggers')).toBe('/projects/p1/triggers');
    expect(capabilityTabHref('p1', 'marketplace')).toBe('/projects/p1/marketplace');
    expect(capabilityTabHref('p1', 'config')).toBe('/projects/p1/config');
  });
});

describe('activeCapabilityTab', () => {
  test('matches the tab segment', () => {
    expect(activeCapabilityTab('/projects/p1/agent')).toBe('agent');
    expect(activeCapabilityTab('/projects/p1/connectors')).toBe('connectors');
    expect(activeCapabilityTab('/projects/p1/skills')).toBe('skills');
    expect(activeCapabilityTab('/projects/p1/triggers')).toBe('triggers');
    expect(activeCapabilityTab('/projects/p1/marketplace')).toBe('marketplace');
    expect(activeCapabilityTab('/projects/p1/config')).toBe('config');
  });
  test('ignores a trailing slash', () => {
    expect(activeCapabilityTab('/projects/p1/skills/')).toBe('skills');
    expect(activeCapabilityTab('/projects/p1/agent/')).toBe('agent');
  });
  test('returns null off the capability routes', () => {
    expect(activeCapabilityTab('/projects/p1/files')).toBeNull();
    expect(activeCapabilityTab('/projects/p1')).toBeNull();
    // `agents` is the OLD Customize section name, not this route.
    expect(activeCapabilityTab('/projects/p1/agents')).toBeNull();
  });
  test('does not match a deeper path that merely ends in a tab key', () => {
    // The Settings overlay is routable at /projects/<id>/settings/<tab>, and
    // its former schedules/webhooks tab ids still redirect through
    // `legacySectionRedirect`. Matching on the last segment alone reported
    // Settings as the capability tab and lit the sidebar's Customize row from
    // inside Settings.
    expect(activeCapabilityTab('/projects/p1/settings/schedules')).toBeNull();
    expect(activeCapabilityTab('/projects/p1/settings/webhooks')).toBeNull();
    expect(activeCapabilityTab('/projects/p1/customize/skills')).toBeNull();
    // The Settings tab's own segment, one level deeper — the overlay route is
    // `/settings/<tab>`, so `config` must not be claimed from there either.
    expect(activeCapabilityTab('/projects/p1/settings/config')).toBeNull();
    // Why the Marketplace tab owns exactly one route: a page added at
    // `/marketplace/<anything>` lands here and un-highlights both the tab and
    // the sidebar's Customize row while it is open. Keep the tab's content at
    // `/projects/<id>/marketplace` with no deeper routes.
    expect(activeCapabilityTab('/projects/p1/marketplace/seo-watch')).toBeNull();
    // `/projects/<id>/subprojects/*` is not a route at all any more — the store
    // moved under Customize and the run report is gone. Pinned so a
    // reintroduced page there cannot quietly claim a Customize tab.
    expect(activeCapabilityTab('/projects/p1/subprojects')).toBeNull();
  });
});
