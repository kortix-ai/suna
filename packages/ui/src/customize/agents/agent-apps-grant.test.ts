import { describe, expect, test } from 'bun:test';

import type { App } from '@kortix/sdk';

import { appGrantRows } from './agent-apps-grant';
import { AGENT_CONFIG_SECTIONS } from '../sections/view/agent-editor';

const app = (over: Partial<App>): App =>
  ({
    app_id: 'app_00',
    account_id: 'acct_1',
    project_id: 'proj_1',
    slug: 'reports-dashboard',
    name: 'Reports dashboard',
    url: 'https://reports-dashboard.apps.example.test',
    access_mode: 'restricted' as const,
    access_revision: 1,
    desired_state: 'running' as const,
    active_deployment_id: null,
    machine: { cpu: 1, memory_gb: 1, disk_gb: 4 },
    idle_timeout_seconds: 900,
    last_request_at: null,
    created_at: '2026-09-22T00:00:00.000Z',
    updated_at: '2026-09-22T00:00:00.000Z',
    ...over,
  }) satisfies App;

describe('appGrantRows', () => {
  test('keys a row on the SLUG, not on app_id', () => {
    // `agents.<name>.apps` stores slugs, and `agentAppAccessDecision`
    // (apps/api/src/apps/access.ts) matches the grant against the App's slug.
    // A row keyed on `app_id` writes a grant the gate never matches, and the
    // App stays closed with nothing saying why.
    const [row] = appGrantRows([app({ app_id: 'app_9f3', slug: 'reports-dashboard' })]);
    expect(row).toEqual({ id: 'reports-dashboard', name: 'Reports dashboard', needsGrant: true });
  });

  test('flags the grant as load-bearing only for restricted and private Apps', () => {
    const rows = appGrantRows([
      app({ slug: 'a-restricted', access_mode: 'restricted' }),
      app({ slug: 'b-private', access_mode: 'private' }),
      app({ slug: 'c-project', access_mode: 'project' }),
      app({ slug: 'd-public', access_mode: 'public' }),
      app({ slug: 'e-password', access_mode: 'password' }),
    ]);
    expect(rows.map((r) => [r.id, r.needsGrant])).toEqual([
      ['a-restricted', true],
      ['b-private', true],
      ['c-project', false],
      ['d-public', false],
      ['e-password', false],
    ]);
  });

  test('sorts by slug and falls back to the slug when an App has no name', () => {
    const rows = appGrantRows([
      app({ slug: 'zulu', name: '' }),
      app({ slug: 'alpha', name: 'Alpha' }),
      app({ slug: 'mike', name: 'Mike' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['alpha', 'mike', 'zulu']);
    expect(rows[0]?.name).toBe('Alpha');
    expect(rows.at(-1)?.name).toBe('zulu');
  });

  test('an undefined list renders nothing rather than throwing', () => {
    expect(appGrantRows(undefined)).toEqual([]);
  });
});

describe('the Apps topic on the agent rail', () => {
  test('sits in the Access group, beside the other grant sets', () => {
    const entry = AGENT_CONFIG_SECTIONS.find((s) => s.key === 'apps');
    expect(entry).toEqual({ key: 'apps', label: 'Apps', group: 'Access' });
  });

  test('is never dropped — Apps is generally available', () => {
    // Apps went GA (2026-10-14): there is no feature flag, so the grant page is
    // a live tab on every project and `?section=apps` always resolves.
    expect(AGENT_CONFIG_SECTIONS.map((s) => s.key)).toContain('apps');
  });
});
