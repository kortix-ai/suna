import { describe, expect, test } from 'bun:test';
import {
  InvalidSessionCostQueryError,
  assembleSessionCostSummary,
  computeBilledSeconds,
  mergeLegacyGatewaySessionRows,
  parseSessionCostListQuery,
  sortLedgerEntriesNewestFirst,
} from './session-costs';

const baseSession = {
  sessionId: 'session-zero',
  projectId: '00000000-0000-4000-a000-000000000101',
  projectName: 'Project One',
  ownerId: null,
  status: 'stopped' as const,
  createdAt: new Date('2026-07-01T10:00:00.000Z'),
  updatedAt: new Date('2026-07-02T11:00:00.000Z'),
};

describe('parseSessionCostListQuery', () => {
  test('applies the documented pagination defaults', () => {
    expect(parseSessionCostListQuery({})).toEqual({ limit: 25, offset: 0 });
  });

  test('accepts the inclusive pagination bounds', () => {
    expect(parseSessionCostListQuery({ limit: '1', offset: '0' })).toEqual({
      limit: 1,
      offset: 0,
    });
    expect(parseSessionCostListQuery({ limit: '100', offset: '200' })).toEqual({
      limit: 100,
      offset: 200,
    });
  });

  test('rejects invalid pagination values', () => {
    for (const input of [
      { limit: '0' },
      { limit: '101' },
      { limit: '1.5' },
      { limit: 'invalid' },
      { offset: '-1' },
      { offset: '1.5' },
    ]) {
      expect(() => parseSessionCostListQuery(input)).toThrow(InvalidSessionCostQueryError);
    }
  });
});

describe('assembleSessionCostSummary', () => {
  test('includes a zero-cost session with null activity and owner identity', () => {
    expect(assembleSessionCostSummary({ session: baseSession })).toEqual({
      session_id: 'session-zero',
      project_id: '00000000-0000-4000-a000-000000000101',
      project_name: 'Project One',
      owner_id: null,
      owner_type: null,
      owner_name: null,
      owner_email: null,
      status: 'stopped',
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-07-02T11:00:00.000Z',
      last_activity_at: null,
      llm_cost: 0,
      compute_cost: 0,
      total_cost: 0,
      request_count: 0,
      error_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      cache_write_tokens: 0,
      model_count: 0,
      compute_seconds: 0,
    });
  });

  test('combines precise numeric rows and uses the newest billed activity', () => {
    const summary = assembleSessionCostSummary({
      session: { ...baseSession, ownerId: '00000000-0000-4000-a000-000000000201' },
      owner: {
        type: 'service_account',
        name: 'automation-agent',
        email: null,
      },
      llm: {
        sessionId: 'session-zero',
        llmCost: '1.1250000000',
        requestCount: '3',
        errorCount: '1',
        inputTokens: '120',
        outputTokens: '45',
        cachedTokens: '20',
        cacheWriteTokens: '8',
        modelCount: '2',
        lastAt: new Date('2026-07-03T12:00:00.000Z'),
      },
      compute: {
        sessionId: 'session-zero',
        computeCost: '0.375000',
        computeSeconds: '90',
        lastAt: '2026-07-03T12:01:00.000Z',
      },
    });

    expect(summary).toMatchObject({
      owner_type: 'service_account',
      owner_name: 'automation-agent',
      llm_cost: 1.125,
      compute_cost: 0.375,
      total_cost: 1.5,
      request_count: 3,
      error_count: 1,
      input_tokens: 120,
      output_tokens: 45,
      cached_tokens: 20,
      cache_write_tokens: 8,
      model_count: 2,
      compute_seconds: 90,
      last_activity_at: '2026-07-03T12:01:00.000Z',
    });
  });
});

describe('computeBilledSeconds', () => {
  test('uses billed_through_at and never the later ended_at or current time', () => {
    expect(computeBilledSeconds('2026-07-01T10:00:00.000Z', '2026-07-01T10:01:30.000Z')).toBe(90);
  });

  test('clamps invalid or reversed windows to zero', () => {
    expect(computeBilledSeconds('invalid', '2026-07-01T10:01:30.000Z')).toBe(0);
    expect(computeBilledSeconds('2026-07-01T10:02:00.000Z', '2026-07-01T10:01:30.000Z')).toBe(0);
  });
});

describe('sortLedgerEntriesNewestFirst', () => {
  test('sorts mixed LLM and compute entries by their billed event time', () => {
    const entries = sortLedgerEntriesNewestFirst([
      {
        kind: 'compute',
        id: 'compute-old',
        started_at: '2026-07-01T10:00:00.000Z',
        ended_at: null,
        billed_through_at: '2026-07-01T10:02:00.000Z',
        cost: 0.2,
        provider: 'daytona',
        state: 'active',
        compute_seconds: 120,
        cpu_cores: 2,
        memory_gb: 4,
        disk_gb: 20,
        gpu_count: 0,
      },
      {
        kind: 'llm',
        id: 'llm-new',
        occurred_at: '2026-07-01T10:03:00.000Z',
        cost: 0.1,
        provider: 'bedrock',
        model: 'anthropic/claude-sonnet-5',
        request_id: 'request-new',
        status: 200,
        ok: true,
        input_tokens: 10,
        output_tokens: 20,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(['llm-new', 'compute-old']);
  });
});

describe('mergeLegacyGatewaySessionRows', () => {
  test('preserves the existing wire fields, total-cost ordering, and 50-row limit', () => {
    const rows = mergeLegacyGatewaySessionRows(
      [
        {
          sessionId: 'session-one',
          requests: 2,
          errors: 1,
          cost: '0.75',
          tokens: '30',
          models: 2,
          lastAt: '2026-07-01T10:00:00.000Z',
        },
      ],
      [
        {
          sessionId: 'session-one',
          cost: '0.25',
          seconds: '60',
          lastAt: '2026-07-01T10:01:00.000Z',
        },
        {
          sessionId: 'session-two',
          cost: '2',
          seconds: '120',
          lastAt: '2026-07-01T10:02:00.000Z',
        },
      ],
    );

    expect(rows).toEqual([
      {
        session_id: 'session-two',
        llm_cost: 0,
        compute_cost: 2,
        requests: 0,
        errors: 0,
        tokens: 0,
        models: 0,
        compute_seconds: 120,
        last_at: '2026-07-01T10:02:00.000Z',
        total_cost: 2,
      },
      {
        session_id: 'session-one',
        llm_cost: 0.75,
        compute_cost: 0.25,
        requests: 2,
        errors: 1,
        tokens: 30,
        models: 2,
        compute_seconds: 60,
        last_at: '2026-07-01T10:01:00.000Z',
        total_cost: 1,
      },
    ]);
  });
});
