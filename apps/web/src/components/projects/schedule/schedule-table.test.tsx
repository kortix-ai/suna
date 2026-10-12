import { describe, expect, test } from 'bun:test';
import type { ProjectTrigger } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import { type EventApp, indexEventApps } from './event-trigger-copy';
import { ScheduleTable } from './schedule-table';

const base: ProjectTrigger = {
  slug: 'triage',
  path: 'kortix.yaml#triggers.triage',
  name: 'Inbox triage',
  type: 'cron',
  agent: 'default',
  model: null,
  enabled: true,
  cron: '0 */10 * * * *',
  run_at: null,
  timezone: 'UTC',
  secret_env: null,
  run: null,
  mode: null,
  interval_seconds: null,
  expect_event_within_seconds: null,
  prompt_template: 'Triage the inbox',
  session_mode: 'reuse',
  session_id: null,
  session_key: null,
  filter: null,
  session_access: { mode: 'private', memberIds: [], groupIds: [] },
  last_fired_at: '2026-10-01T06:00:00.000Z',
  last_status: 'fired',
  last_error: null,
  last_attempt_at: '2026-10-01T06:00:00.000Z',
  webhook_url: null,
  event: null,
};

const apps = indexEventApps([
  { app: 'github', name: 'GitHub', logo: null } as unknown as EventApp,
  { app: 'gmail', name: 'Gmail', logo: null } as unknown as EventApp,
]);

function row(trigger: ProjectTrigger, withCatalog = true): string {
  return renderToStaticMarkup(
    <ScheduleTable
      triggers={[trigger]}
      controls={{ canCreate: true, canFire: true, canUpdate: true, canDelete: true }}
      runningSlug={null}
      togglingSlug={null}
      onOpen={() => {}}
      onRun={() => {}}
      onToggle={() => {}}
      onDelete={() => {}}
      apps={withCatalog ? apps : undefined}
      agentLabel={(slug) => (slug === 'default' ? 'Kortix' : slug)}
    />,
  );
}

// Prod 2026-09-30: a trigger's runs failed for hours and the list still
// showed it as an ordinary active schedule.
describe('a trigger whose last run failed', () => {
  test('shows the Error badge on its row, and no red tile or error line', () => {
    const out = row({ ...base, last_status: 'failed', last_error: 'Provider unavailable: socket hang up' });
    expect(out).toContain('Error');
    expect(out).not.toContain('Provider unavailable');
  });

  test('a healthy trigger shows no badge at all', () => {
    const out = row(base);
    expect(out).not.toContain('data-slot="badge"');
    expect(out).not.toContain('Live');
    expect(out).not.toContain('kortix-red');
  });
});

describe('a schedule row', () => {
  test('leads with a clock, then the cadence over the timezone', () => {
    const out = row(base);
    expect(out).toContain('Every 10 minutes');
    expect(out).toContain('UTC');
  });

  test('a paused schedule shows the Paused badge', () => {
    expect(row({ ...base, enabled: false })).toContain('Paused');
  });

  test('names the agent as the agent picker does', () => {
    const out = row(base);
    expect(out).toContain('Kortix');
    expect(out).not.toContain('>default<');
  });
});

describe('a webhook row', () => {
  test('shows its secret name under "When a request arrives"', () => {
    const out = row({ ...base, type: 'webhook', cron: null, secret_env: 'WEBHOOK_TRIAGE_SECRET' });
    expect(out).toContain('When a request arrives');
    expect(out).toContain('WEBHOOK_TRIAGE_SECRET');
  });
});

const eventTrigger = (
  event: Partial<NonNullable<ProjectTrigger['event']>>,
  enabled = true,
): ProjectTrigger => ({
  ...base,
  slug: 'new-pr',
  name: 'Review new pull requests',
  type: 'event',
  enabled,
  cron: null,
  timezone: '',
  event: {
    connector: 'github',
    type: 'GITHUB_PULL_REQUEST_EVENT',
    config: { owner: 'acme', repo: 'api' },
    provider: 'composio',
    app: 'github',
    status: 'active',
    error: null,
    last_event_at: null,
    ...event,
  },
});

describe('an app event trigger', () => {
  test('names the event and the real app, never the wire id or "<event> on <App>"', () => {
    const out = row(eventTrigger({}));
    expect(out).toContain('Pull Request');
    expect(out).toContain('GitHub');
    expect(out).not.toContain('GITHUB_PULL_REQUEST_EVENT');
    expect(out).not.toMatch(/ on GitHub/);
  });

  test('falls back to the slug as written, never a capitalised slug', () => {
    const out = row(eventTrigger({ app: 'docs-mcp', connector: 'docs-mcp', type: 'DOCS_MCP_PAGE_EDITED' }), false);
    expect(out).toContain('docs-mcp');
    expect(out).not.toContain('Docs-mcp');
    expect(out).not.toContain('Docs mcp');
  });

  test('the second line carries connector, account and source', () => {
    const out = row(
      eventTrigger({ connector: 'github-work', account: 'acme-bot', source: 'composio' }),
    );
    expect(out).toContain('GitHub · github-work · acme-bot · via Composio');
  });

  test('a live trigger shows no status badge', () => {
    expect(row(eventTrigger({}))).not.toContain('Live');
  });

  test('shows Needs connection until a shared account exists', () => {
    expect(row(eventTrigger({ status: 'needs_connection' }))).toContain('Needs connection');
  });

  test('shows Error, and keeps the provider text off the row', () => {
    const out = row(eventTrigger({ status: 'error', error: 'Provider rejected the repo' }));
    expect(out).toContain('Error');
    expect(out).not.toContain('Provider rejected the repo');
  });

  test('shows Setting up while no subscription row exists', () => {
    expect(row(eventTrigger({ status: 'pending' }))).toContain('Setting up');
  });

  test('a paused event trigger reads Paused, not its subscription state', () => {
    const out = row(eventTrigger({ status: 'error', error: 'x' }, false));
    expect(out).toContain('Paused');
    expect(out).not.toContain('Error');
  });

  test('shows the last event, not the last fire', () => {
    const out = row(eventTrigger({ last_event_at: new Date(Date.now() - 3 * 60_000).toISOString() }));
    expect(out).toContain('3 minutes ago');
  });
});
