import { describe, expect, test } from 'bun:test';
import { describeProviderCoverage } from './sandbox-provider-coverage';

describe('sandbox template provider coverage presentation', () => {
  test('uses explicit launch-readiness language for every provider state', () => {
    expect(describeProviderCoverage('ready')).toEqual({ label: 'Ready', tone: 'ok' });
    expect(describeProviderCoverage('building')).toEqual({ label: 'Building', tone: 'busy' });
    expect(describeProviderCoverage('failed')).toEqual({ label: 'Failed', tone: 'fail' });
    expect(describeProviderCoverage('not_built')).toEqual({ label: 'Not built', tone: 'idle' });
    expect(describeProviderCoverage('unavailable')).toEqual({ label: 'Unavailable', tone: 'idle' });
    expect(describeProviderCoverage('unknown')).toEqual({ label: 'Unknown', tone: 'idle' });
  });
});
