import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionCostDetail } from '@kortix/sdk';

import { SessionCostDetailContent } from './session-cost-detail';

const detail = {
  session_id: 'session-detail',
  project_id: 'project-detail',
  project_name: 'Research workflows',
  owner_id: 'owner-1',
  owner_type: 'user',
  owner_name: 'Session owner',
  owner_email: 'owner@example.test',
  status: 'running',
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
  model_usage: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet',
      request_count: 2,
      error_count: 0,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 10,
      cache_write_tokens: 5,
      cost: 1.25,
      last_at: '2026-07-01T11:00:00.000Z',
    },
  ],
  ledger_entries: [
    {
      kind: 'llm',
      id: 'llm-entry',
      occurred_at: '2026-07-01T11:00:00.000Z',
      cost: 1.25,
      provider: 'anthropic',
      model: 'claude-sonnet',
      request_id: 'request-1',
      status: 200,
      ok: true,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 10,
      cache_write_tokens: 5,
    },
    {
      kind: 'compute',
      id: 'compute-entry',
      started_at: '2026-07-01T10:00:00.000Z',
      ended_at: '2026-07-01T10:02:00.000Z',
      billed_through_at: '2026-07-01T10:02:00.000Z',
      cost: 0.5,
      provider: 'daytona',
      state: 'stopped',
      compute_seconds: 120,
      cpu_cores: 2,
      memory_gb: 4,
      disk_gb: 20,
      gpu_count: 0,
    },
  ],
} satisfies SessionCostDetail;

describe('SessionCostDetailContent', () => {
  test('renders totals, model usage, both ledger kinds, and the canonical session link', () => {
    const html = renderToStaticMarkup(
      <SessionCostDetailContent detail={detail} isLoading={false} error={null} />,
    );

    expect(html).toContain('Session cost details');
    expect(html).toContain('$1.75');
    expect(html).toContain('claude-sonnet');
    expect(html).toContain('request-1');
    expect(html).toContain('2m');
    expect(html).toContain('2 vCPU');
    expect(html).toContain('href="/projects/project-detail/sessions/session-detail"');
  });

  test('renders loading and error states without stale detail', () => {
    const loading = renderToStaticMarkup(
      <SessionCostDetailContent detail={undefined} isLoading error={null} />,
    );
    const failed = renderToStaticMarkup(
      <SessionCostDetailContent
        detail={undefined}
        isLoading={false}
        error={new Error('detail failed')}
      />,
    );

    expect(loading).toContain('Loading session cost details');
    expect(failed).toContain('Failed to load session cost details');
    expect(failed).toContain('detail failed');
  });

  test('renders an explicit empty ledger', () => {
    const html = renderToStaticMarkup(
      <SessionCostDetailContent
        detail={{ ...detail, model_usage: [], ledger_entries: [] }}
        isLoading={false}
        error={null}
      />,
    );

    expect(html).toContain('No cost entries');
    expect(html).toContain('This session has no finalized LLM or compute entries.');
  });
});
