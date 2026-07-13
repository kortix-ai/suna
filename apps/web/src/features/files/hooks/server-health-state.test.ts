import { describe, expect, test } from 'bun:test';
import { fileServerHealthState } from './server-health-state';

describe('fileServerHealthState', () => {
  test('keeps Files available while daemon is connected but runtime readiness is false', () => {
    expect(fileServerHealthState('connected', false, '1.2.3')).toEqual({
      healthy: true,
      version: '1.2.3',
    });
  });
  test('reports a truly unreachable daemon as unhealthy', () => {
    expect(fileServerHealthState('unreachable', false, null)).toEqual({
      healthy: false,
      version: '',
    });
  });
  test('keeps initial unresolved state loading', () => {
    expect(fileServerHealthState('connecting', null, null)).toBeUndefined();
  });
});
