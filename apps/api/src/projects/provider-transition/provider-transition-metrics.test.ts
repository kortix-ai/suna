import { beforeEach, describe, expect, test } from 'bun:test';
import {
  emitProviderTransitionEvent,
  providerTransitionMetricsSnapshot,
  resetProviderTransitionMetricsForTest,
} from './provider-transition-metrics';

beforeEach(() => resetProviderTransitionMetricsForTest());

describe('provider transition metrics', () => {
  test('events increment per-event and per-event:target tallies', () => {
    emitProviderTransitionEvent('requested', { target: 'platinum', source: 'daytona', projectId: 'p1' });
    emitProviderTransitionEvent('build_started', { target: 'platinum', projectId: 'p1', queueSeconds: 3 });
    emitProviderTransitionEvent('activation_completed', { target: 'platinum', projectId: 'p1', timeToReadySeconds: 42 });
    const snap = providerTransitionMetricsSnapshot();
    expect(snap['requested']).toBe(1);
    expect(snap['requested:platinum']).toBe(1);
    expect(snap['activation_completed']).toBe(1);
    expect(snap['build_started:platinum']).toBe(1);
  });

  test('cold_fallback is tracked distinctly so a post-activation cold boot is observable (should be 0)', () => {
    expect(providerTransitionMetricsSnapshot()['cold_fallback']).toBeUndefined();
    emitProviderTransitionEvent('cold_fallback', { target: 'platinum', projectId: 'p1' });
    expect(providerTransitionMetricsSnapshot()['cold_fallback']).toBe(1);
  });
});
