import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionCostsPage } from '@kortix/sdk';

import { SessionCostExplorerContent } from './session-cost-explorer';

const baseSummary = {
  project_id: 'project-1',
  project_name: 'Support workflows',
  status: 'stopped',
  created_at: '2026-07-01T10:00:00.000Z',
  updated_at: '2026-07-01T11:00:00.000Z',
  last_activity_at: '2026-07-01T11:00:00.000Z',
  llm_cost: 1.25,
  compute_cost: 0.5,
  total_cost: 1.75,
  request_count: 2,
  error_count: 0,
  input_tokens: 100,
  output_tokens: 50,
  cached_tokens: 10,
  cache_write_tokens: 5,
  model_count: 1,
  compute_seconds: 120,
} as const;

const page = {
  sessions: [
    {
      ...baseSummary,
      session_id: 'session-user',
      owner_id: 'user-1',
      owner_type: 'user',
      owner_name: 'User Owner',
      owner_email: 'owner@example.test',
    },
    {
      ...baseSummary,
      session_id: 'session-service',
      owner_id: 'service-1',
      owner_type: 'service_account',
      owner_name: 'Build service',
      owner_email: null,
      total_cost: 0.0000000042,
      llm_cost: 0.0000000042,
      compute_cost: 0,
    },
    {
      ...baseSummary,
      session_id: 'session-unknown',
      owner_id: 'stale-1',
      owner_type: 'unknown',
      owner_name: null,
      owner_email: null,
    },
  ],
  total: 3,
  limit: 25,
  offset: 0,
  next_offset: null,
  reconciliation: {
    llm_cost: 0.25,
    compute_cost: 0.5,
    total_cost: 0.75,
    request_count: 1,
    compute_window_count: 1,
    compute_seconds: 60,
  },
} satisfies SessionCostsPage;

function renderExplorer(data: SessionCostsPage = page) {
  return renderToStaticMarkup(
    <SessionCostExplorerContent
      data={data}
      projects={[{ project_id: 'project-1', name: 'Support workflows' }]}
      selectedProjectId={null}
      isLoading={false}
      error={null}
      projectError={null}
      onProjectChange={() => {}}
      onPreviousPage={() => {}}
      onNextPage={() => {}}
      onSelectSession={() => {}}
    />,
  );
}

describe('SessionCostExplorerContent', () => {
  test('renders session, project, owner, and precise cost cells with accessible details', () => {
    const html = renderExplorer();

    expect(html).toContain('session-user');
    expect(html).toContain('Support workflows');
    expect(html).toContain('User Owner');
    expect(html).toContain('owner@example.test');
    expect(html).toContain('Build service');
    expect(html).toContain('Unknown owner');
    expect(html).toContain('&lt;$0.01');
    expect(html).toContain('aria-label="View cost details for session session-user"');
  });

  test('renders reconciliation separately from paginated session rows', () => {
    const html = renderExplorer();

    expect(html).toContain('Unassigned costs');
    expect(html).toContain('$0.75');
    expect(html).toContain('Showing 1-3 of 3 sessions');
    expect(html).toContain('disabled=""');
  });

  test('shows zero-cost unreconciled activity', () => {
    const html = renderExplorer({
      ...page,
      reconciliation: {
        llm_cost: 0,
        compute_cost: 0,
        total_cost: 0,
        request_count: 2,
        compute_window_count: 0,
        compute_seconds: 0,
      },
    });

    expect(html).toContain('Unassigned costs');
    expect(html).toContain('2 LLM requests');
  });

  test('keeps cost rows visible when the optional project catalog fails', () => {
    const html = renderToStaticMarkup(
      <SessionCostExplorerContent
        data={page}
        projects={[]}
        selectedProjectId={null}
        isLoading={false}
        error={null}
        projectError={new Error('Project catalog unavailable')}
        onProjectChange={() => {}}
        onPreviousPage={() => {}}
        onNextPage={() => {}}
        onSelectSession={() => {}}
      />,
    );

    expect(html).toContain('Project filter unavailable');
    expect(html).toContain('Project catalog unavailable');
    expect(html).toContain('session-user');
  });

  test('renders an explicit empty state', () => {
    const html = renderExplorer({
      ...page,
      sessions: [],
      total: 0,
      reconciliation: {
        llm_cost: 0,
        compute_cost: 0,
        total_cost: 0,
        request_count: 0,
        compute_window_count: 0,
        compute_seconds: 0,
      },
    });

    expect(html).toContain('No session costs');
    expect(html).toContain('Session cost records appear after sessions are created.');
  });
});
