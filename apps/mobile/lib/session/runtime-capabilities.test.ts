import { describe, expect, test } from 'bun:test';

import { recordRuntimeCapabilities, runtimeSupportsAt, unsupportedFeatureMessage } from './runtime-capabilities';

const PI = ['file.import', 'session.subagents'];
const OPENCODE = ['file.import', 'session.rewind', 'session.compact', 'session.commands', 'session.subagents'];

describe('runtime capabilities', () => {
  test("a pi runtime's list hides rewind, compact, and commands on that computer only", () => {
    recordRuntimeCapabilities('https://a', PI);
    expect(runtimeSupportsAt('https://a', 'session.rewind')).toBe(false);
    expect(runtimeSupportsAt('https://a', 'session.compact')).toBe(false);
    expect(runtimeSupportsAt('https://a', 'session.commands')).toBe(false);
    expect(runtimeSupportsAt('https://a', 'session.subagents')).toBe(true);
    expect(runtimeSupportsAt('https://b', 'session.rewind')).toBe(true);
  });

  test('an answer without a list keeps the last one; a new list replaces it', () => {
    recordRuntimeCapabilities('https://a', PI);
    recordRuntimeCapabilities('https://a', undefined);
    expect(runtimeSupportsAt('https://a', 'session.rewind')).toBe(false);
    recordRuntimeCapabilities('https://a', OPENCODE);
    expect(runtimeSupportsAt('https://a', 'session.rewind')).toBe(true);
  });

  test('a pre-capabilities daemon (no session.* entry) serves everything', () => {
    recordRuntimeCapabilities('https://a', ['file.import']);
    expect(runtimeSupportsAt('https://a', 'session.compact')).toBe(true);
  });
});

describe('unsupportedFeatureMessage', () => {
  test("a refused feature answers in the runtime's own words", () => {
    expect(unsupportedFeatureMessage(new Error('session rewind is not supported by the pi harness'))).toBe(
      'session rewind is not supported by the pi harness',
    );
    expect(
      unsupportedFeatureMessage({ error: 'a pi subagent session is read-only; its parent task drives it' }),
    ).toBe('a pi subagent session is read-only; its parent task drives it');
  });

  test('any other failure is not a refused feature', () => {
    expect(unsupportedFeatureMessage(new Error('Network request failed'))).toBeNull();
    expect(unsupportedFeatureMessage(new Error('Server returned 500'))).toBeNull();
    expect(unsupportedFeatureMessage(null)).toBeNull();
  });
});

describe('the SDK capability gate', () => {
  test("the app's health probe reports the list to the SDK's connection store", async () => {
    const { useRuntimeConnectionStore } = await import('@kortix/sdk/react');
    recordRuntimeCapabilities('https://a', PI);
    expect(useRuntimeConnectionStore.getState().runtimeCapabilities).toEqual(PI);
  });
});
