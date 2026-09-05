import { describe, expect, test } from 'bun:test';
import {
  CAPABILITY_TABS,
  PRIMARY_TABS,
  activeCapabilityTab,
  agentHref,
  capabilityTabHref,
  channelsHref,
} from './capability-tab-routes';

describe('CAPABILITY_TABS', () => {
  test('lists agent, skills, connectors, triggers, review, models, secrets, config in that order', () => {
    // Agents lead the bar (Marko, 2026-09-01): an agent is the one object a
    // person is granted access to, so it is the object Customize is built
    // around. Skills — the other thing you BUILD — follows; the rest is what
    // agents draw on. Review joined the row on 2026-09-02, when the trailing
    // Settings tab (`config`) was retired. Models led before all of that
    // (Jay, 2026-08-17).
    expect(CAPABILITY_TABS.map((t) => t.key)).toEqual([
      'agent',
      'skills',
      'connectors',
      'triggers',
      'review',
      'models',
      'secrets',
      'config',
    ]);
  });

  test('the primary group is Agents alone, and it is a prefix of the bar', () => {
    // Skills moved to the right of the seam (Marko, 2026-09-03): it is
    // something an agent draws on, like the rest of the library.
    expect(PRIMARY_TABS).toEqual(['agent']);
    expect(CAPABILITY_TABS.slice(0, PRIMARY_TABS.length).map((t) => t.key)).toEqual([
      ...PRIMARY_TABS,
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
    expect(channelsHref('p1')).toBe('/projects/p1/customize/connectors?scope=channels');
  });


  test('the Agents tab keeps a singular key and a plural label', () => {
    // The key IS the URL segment (`/projects/<id>/agent`); pluralizing it here
    // would 404 the route while the tab still rendered.
    const agents = CAPABILITY_TABS.find((t) => t.label === 'Agents');
    expect(agents?.key).toBe('agent');
  });
});

describe('the Settings tab', () => {
  test('keys on `config`, never on `settings`', () => {
    // `/projects/<id>/settings` is the settings OVERLAY's deep-link route. Two
    // routes cannot share one segment, so the tab that holds project
    // configuration takes `config` and keeps the label a person reads.
    const settings = CAPABILITY_TABS.find((t) => t.label === 'Settings');
    expect(settings?.key).toBe('config');
    expect(CAPABILITY_TABS.map((t) => t.key)).not.toContain('settings');
  });
});

describe('capabilityTabHref', () => {
  test('builds a project-scoped path', () => {
    expect(capabilityTabHref('p1', 'skills')).toBe('/projects/p1/customize/skills');
    expect(capabilityTabHref('p1', 'agent')).toBe('/projects/p1/customize/agents');
    expect(capabilityTabHref('p1', 'triggers')).toBe('/projects/p1/customize/triggers');
    expect(capabilityTabHref('p1', 'review')).toBe('/projects/p1/customize/review');
  });
});

describe('agentHref', () => {
  test('nests one agent under the Agents tab and encodes the manifest key', () => {
    expect(agentHref('p1', 'churn')).toBe('/projects/p1/customize/agents/churn');
    expect(agentHref('p1', 'a b/c')).toBe('/projects/p1/customize/agents/a%20b%2Fc');
  });
});

describe('activeCapabilityTab', () => {
  test("lights Agents on one agent's page, and only there among deeper paths", () => {
    expect(activeCapabilityTab(agentHref('p1', 'churn'))).toBe('agent');
    expect(activeCapabilityTab('/projects/p1/customize/agents/churn/')).toBe('agent');
    // Only the third segment `agent` earns the deeper match — a skill or a
    // trigger one level down is not a route and must not light a tab.
    expect(activeCapabilityTab('/projects/p1/customize/skills/foo')).toBeNull();
    expect(activeCapabilityTab('/projects/p1/customize/agents/a/b')).toBeNull();
  });
  test('matches the tab segment', () => {
    expect(activeCapabilityTab('/projects/p1/customize/agents')).toBe('agent');
    expect(activeCapabilityTab('/projects/p1/customize/connectors')).toBe('connectors');
    expect(activeCapabilityTab('/projects/p1/customize/skills')).toBe('skills');
    expect(activeCapabilityTab('/projects/p1/customize/triggers')).toBe('triggers');
    expect(activeCapabilityTab('/projects/p1/customize/review')).toBe('review');
  });
  test('ignores a trailing slash', () => {
    expect(activeCapabilityTab('/projects/p1/customize/skills/')).toBe('skills');
    expect(activeCapabilityTab('/projects/p1/customize/agents/')).toBe('agent');
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
    // A tab key one level deeper under the overlay route is the overlay's
    // redirect, not this bar's tab.
    expect(activeCapabilityTab('/projects/p1/settings/review')).toBeNull();
    // The Settings tab's own path IS its tab; one level deeper is not.
    expect(activeCapabilityTab('/projects/p1/customize/settings')).toBe('config');
    expect(activeCapabilityTab('/projects/p1/customize/settings/general')).toBeNull();
  });
});
