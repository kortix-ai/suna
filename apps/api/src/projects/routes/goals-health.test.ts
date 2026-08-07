import { describe, expect, test } from 'bun:test';
import { deriveProjectGoalHealth } from './goals-tasks-service';

const evaluations = [
  { evaluationId: 'evaluation-4', state: 'queued' as const, observations: { latency: 80 } },
  { evaluationId: 'evaluation-3', state: 'fired' as const, observations: { latency: 100 } },
  { evaluationId: 'evaluation-2', state: 'fired' as const, observations: { latency: 100 } },
  { evaluationId: 'evaluation-1', state: 'fired' as const, observations: { latency: 100 } },
];

describe('goal health derivation', () => {
  test('does not infer completion and reports missing declared metrics as unmeasurable', () => {
    expect(
      deriveProjectGoalHealth({
        goalSlug: 'speed',
        desiredStatus: 'active',
        metricNames: ['latency', 'availability'],
        evaluations,
      }),
    ).toEqual({
      goal_slug: 'speed',
      desired_status: 'active',
      health_status: 'stalled',
      metrics: [
        {
          metric: 'latency',
          status: 'stalled',
          evaluation_id: 'evaluation-4',
          evaluation_state: 'queued',
          observation_value: 80,
        },
        {
          metric: 'availability',
          status: 'unmeasurable',
          evaluation_id: 'evaluation-4',
          evaluation_state: 'queued',
          observation_value: null,
        },
      ],
    });
  });

  test('requires three consecutive fired evaluations with identical finite values', () => {
    expect(
      deriveProjectGoalHealth({
        goalSlug: 'speed',
        desiredStatus: 'paused',
        metricNames: ['latency'],
        evaluations: [
          { evaluationId: 'e4', state: 'fired', observations: { latency: 99 } },
          { evaluationId: 'e3', state: 'fired', observations: { latency: 100 } },
          { evaluationId: 'e2', state: 'fired', observations: { latency: 100 } },
          { evaluationId: 'e1', state: 'fired', observations: { latency: 100 } },
        ],
      }).metrics[0]?.status,
    ).toBe('measuring');
  });

  test('treats a metric missing from the latest fired evaluation as unmeasurable', () => {
    expect(
      deriveProjectGoalHealth({
        goalSlug: 'speed',
        desiredStatus: 'active',
        metricNames: ['latency'],
        evaluations: [
          { evaluationId: 'e4', state: 'fired', observations: {} },
          { evaluationId: 'e3', state: 'fired', observations: { latency: 100 } },
          { evaluationId: 'e2', state: 'fired', observations: { latency: 100 } },
          { evaluationId: 'e1', state: 'fired', observations: { latency: 100 } },
        ],
      }).metrics[0]?.status,
    ).toBe('unmeasurable');
  });
});
