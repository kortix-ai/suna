import { describe, expect, test } from 'bun:test';
import {
  decideSessionRuntimePair,
  type EnvironmentRuntimeState,
  type WorkerRuntimeState,
} from './session-runtime-state';

const workers: WorkerRuntimeState[] = ['missing', 'live', 'parked'];
const environments: EnvironmentRuntimeState[] = [
  'missing',
  'provisioning',
  'active',
  'stopped',
  'error',
];

describe('worker and environment state matrix', () => {
  test('defines every reachable pair', () => {
    for (const worker of workers) {
      for (const environment of environments) {
        expect(decideSessionRuntimePair(worker, environment)).toBeDefined();
      }
    }
  });

  test('a live worker owns turn authority and lazily repairs compute', () => {
    expect(decideSessionRuntimePair('live', 'missing')).toEqual({
      legal: true,
      environmentAction: 'ensure',
      turnAuthority: 'worker',
    });
    expect(decideSessionRuntimePair('live', 'stopped').environmentAction).toBe('ensure');
    expect(decideSessionRuntimePair('live', 'error').environmentAction).toBe('ensure');
    expect(decideSessionRuntimePair('live', 'provisioning').environmentAction).toBe('wait');
    expect(decideSessionRuntimePair('live', 'active').environmentAction).toBe('serve');
  });

  test('a parked worker cannot retain running or provisioning compute', () => {
    expect(decideSessionRuntimePair('parked', 'active')).toEqual({
      legal: false,
      environmentAction: 'stop',
      turnAuthority: 'none',
    });
    expect(decideSessionRuntimePair('parked', 'provisioning').environmentAction).toBe('stop');
  });

  test('an environment without a session is deleted', () => {
    for (const environment of environments.filter((state) => state !== 'missing')) {
      expect(decideSessionRuntimePair('missing', environment)).toEqual({
        legal: false,
        environmentAction: 'delete',
        turnAuthority: 'none',
      });
    }
    expect(decideSessionRuntimePair('missing', 'missing')).toEqual({
      legal: true,
      environmentAction: 'none',
      turnAuthority: 'none',
    });
  });
});
