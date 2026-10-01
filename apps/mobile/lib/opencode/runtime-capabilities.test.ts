import { describe, expect, test } from 'bun:test';

import {
  FeatureNotSupportedError,
  featureNotSupportedError,
  recordRuntimeCapabilities,
  runtimeSupportsAt,
} from './runtime-capabilities';

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

describe('featureNotSupportedError', () => {
  test("a 501 feature_not_supported answer carries the runtime's words", () => {
    const error = featureNotSupportedError(
      501,
      JSON.stringify({ code: 'feature_not_supported', error: 'session rewind is not supported by the pi harness' }),
    );
    expect(error).toBeInstanceOf(FeatureNotSupportedError);
    expect(error?.message).toBe('session rewind is not supported by the pi harness');
  });

  test('any other answer is null', () => {
    expect(featureNotSupportedError(500, JSON.stringify({ code: 'feature_not_supported', error: 'x' }))).toBeNull();
    expect(featureNotSupportedError(501, JSON.stringify({ error: 'not implemented' }))).toBeNull();
    expect(featureNotSupportedError(501, JSON.stringify({ code: 'feature_not_supported' }))).toBeNull();
    expect(featureNotSupportedError(501, 'Not Implemented')).toBeNull();
    expect(featureNotSupportedError(501, 'null')).toBeNull();
  });
});
