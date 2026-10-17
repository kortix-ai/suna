import { describe, expect, test } from 'bun:test';

import { manifestRuntime, selectSessionHarness } from './session-harness';

describe('selectSessionHarness — flag OR manifest', () => {
  test('flag on ⇒ pi, whatever the manifest says', () => {
    expect(selectSessionHarness({ piHarnessFlag: true, runtime: 'opencode', llmGateway: true })).toBe('pi');
    expect(selectSessionHarness({ piHarnessFlag: true, runtime: 'pi', llmGateway: true })).toBe('pi');
    expect(selectSessionHarness({ piHarnessFlag: true, runtime: null, llmGateway: true })).toBe('pi');
  });

  test('flag off, manifest runtime: pi ⇒ pi', () => {
    expect(selectSessionHarness({ piHarnessFlag: false, runtime: 'pi', llmGateway: true })).toBe('pi');
  });

  test('everything else is opencode', () => {
    expect(selectSessionHarness({ piHarnessFlag: false, runtime: 'opencode', llmGateway: true })).toBe('opencode');
    expect(selectSessionHarness({ piHarnessFlag: false, runtime: null, llmGateway: true })).toBe('opencode');
  });

  test('gateway off ⇒ opencode, always', () => {
    expect(selectSessionHarness({ piHarnessFlag: true, runtime: 'pi', llmGateway: false })).toBe('opencode');
    expect(selectSessionHarness({ piHarnessFlag: false, runtime: 'pi', llmGateway: false })).toBe('opencode');
    expect(selectSessionHarness({ piHarnessFlag: true, runtime: null, llmGateway: false })).toBe('opencode');
  });
});

describe('manifestRuntime — tolerant version read', () => {
  test('v2/v3 manifest with runtime: pi ⇒ pi', () => {
    expect(manifestRuntime({ kortix_version: 2, runtime: 'pi' })).toBe('pi');
    expect(manifestRuntime({ kortix_version: 3, runtime: 'pi' })).toBe('pi');
  });

  test('string version and missing runtime fall back', () => {
    expect(manifestRuntime({ kortix_version: '2' })).toBe('opencode');
    expect(manifestRuntime({ kortix_version: 2, runtime: 'opencode' })).toBe('opencode');
  });

  test('not an object, not a manifest, unreadable ⇒ opencode', () => {
    expect(manifestRuntime(null)).toBe('opencode');
    expect(manifestRuntime('kortix_version: 2')).toBe('opencode');
    expect(manifestRuntime({ runtime: 'pi' })).toBe('opencode');
    expect(manifestRuntime({ kortix_version: 1, runtime: 'pi' })).toBe('opencode');
  });
});
