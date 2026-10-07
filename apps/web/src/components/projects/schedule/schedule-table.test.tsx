import { describe, expect, test } from 'bun:test';
import type { ProjectTrigger } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

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

function row(trigger: ProjectTrigger): string {
  return renderToStaticMarkup(
    <ScheduleTable
      triggers={[trigger]}
      canWrite
      runningSlug={null}
      togglingSlug={null}
      onOpen={() => {}}
      onRun={() => {}}
      onToggle={() => {}}
      onDelete={() => {}}
    />,
  );
}

// Prod 2026-09-30: a trigger's runs failed for hours and the list still
// showed it as an ordinary active schedule.
describe('a trigger whose last run failed', () => {
  test('shows the failure on its row', () => {
    const out = row({ ...base, last_status: 'failed', last_error: 'Provider unavailable: socket hang up' });
    expect(out).toContain('Last run didn’t finish');
    expect(out).toContain('bg-kortix-red/15');
  });

  test('a healthy trigger shows no failure', () => {
    const out = row(base);
    expect(out).not.toContain('Last run didn’t finish');
    expect(out).not.toContain('kortix-red');
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
  test('names the app and the event, never the wire id', () => {
    const out = row(eventTrigger({}));
    expect(out).toContain('Pull request on Github');
    expect(out).not.toContain('GITHUB_PULL_REQUEST_EVENT');
  });

  test('shows Live when the subscription is active', () => {
    expect(row(eventTrigger({}))).toContain('Live');
  });

  test('shows Needs connection until a shared account exists', () => {
    expect(row(eventTrigger({ status: 'needs_connection' }))).toContain('Needs connection');
  });

  test('shows Error with the provider text', () => {
    const out = row(eventTrigger({ status: 'error', error: 'Provider rejected the repo' }));
    expect(out).toContain('Error');
    expect(out).toContain('Provider rejected the repo');
  });

  test('shows Activating while no subscription row exists', () => {
    expect(row(eventTrigger({ status: 'pending' }))).toContain('Activating');
  });

  test('shows the last event, not the last fire', () => {
    const out = row(eventTrigger({ last_event_at: new Date(Date.now() - 3 * 60_000).toISOString() }));
    expect(out).toContain('3 minutes ago');
  });
});
