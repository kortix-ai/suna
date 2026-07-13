import { describe, expect, test } from 'bun:test';
import {
  describeProviderCoverage,
  describeProviderMode,
  sandboxProviderLabel,
} from './sandbox-provider-coverage';

describe('sandbox template provider coverage presentation', () => {
  test('uses explicit launch-readiness language for every provider state', () => {
    expect(describeProviderCoverage('ready')).toEqual({ label: 'Latest', tone: 'ok' });
    expect(describeProviderCoverage('building')).toEqual({ label: 'Building', tone: 'busy' });
    expect(describeProviderCoverage('failed')).toEqual({ label: 'Failed', tone: 'fail' });
    expect(describeProviderCoverage('not_built')).toEqual({
      label: 'Current image not built',
      tone: 'idle',
    });
    expect(describeProviderCoverage('unavailable')).toEqual({ label: 'Unavailable', tone: 'idle' });
    expect(describeProviderCoverage('unknown')).toEqual({ label: 'Unknown', tone: 'idle' });
  });

  test('keeps Automatic neutral and names the selected pinned provider', () => {
    expect(describeProviderMode('automatic', 'daytona')).toEqual({
      label: 'Automatic',
      selectedProvider: null,
    });
    expect(describeProviderMode('pinned', 'e2b')).toEqual({
      label: 'E2B selected',
      selectedProvider: 'E2B',
    });
    expect(sandboxProviderLabel('e2b')).toBe('E2B');
  });
});
