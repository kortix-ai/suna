import { describe, expect, test } from 'bun:test';
import type { ModelKey } from './use-model-store';
import { EMPTY_SESSION_PICKS, parseSessionPicks } from './use-session-picks';

const MODEL: ModelKey = { providerID: 'anthropic', modelID: 'claude' };

/**
 * `useSessionPicks` persists to `localStorage` and there is no React test
 * renderer in this package, so the part that can silently corrupt a send — the
 * parse of whatever is already in storage — is a pure function, asserted here.
 *
 * The `variant` (reasoning effort) field is NEW. Entries written before it
 * existed hold `{model, agent}` only, and a raw `JSON.parse` of those leaves
 * `variant` as `undefined` rather than `null`, which is a different value on
 * the wire than "no variant" once `sendParts` starts reading it.
 */

describe('parseSessionPicks', () => {
  test('an absent entry is all-null, never undefined', () => {
    expect(parseSessionPicks(null)).toEqual(EMPTY_SESSION_PICKS);
    expect(EMPTY_SESSION_PICKS).toEqual({ model: null, agent: null, variant: null });
  });

  test('an entry written before `variant` existed reads back as variant: null', () => {
    // The exact shape `useSessionPicks` wrote until this change.
    expect(
      parseSessionPicks('{"model":{"providerID":"anthropic","modelID":"claude"},"agent":"build"}'),
    ).toEqual({ model: MODEL, agent: 'build', variant: null });
  });

  test('round-trips all three fields', () => {
    expect(
      parseSessionPicks(
        '{"model":{"providerID":"anthropic","modelID":"claude","provider":"anthropic"},"agent":"a","variant":"high"}',
      ),
    ).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude', provider: 'anthropic' },
      agent: 'a',
      variant: 'high',
    });
  });

  test('malformed or non-object JSON falls back to all-null instead of throwing', () => {
    // A send path must not be able to crash on a corrupt storage entry.
    expect(parseSessionPicks('not json')).toEqual(EMPTY_SESSION_PICKS);
    expect(parseSessionPicks('null')).toEqual(EMPTY_SESSION_PICKS);
    expect(parseSessionPicks('[1,2]')).toEqual(EMPTY_SESSION_PICKS);
    expect(parseSessionPicks('"a string"')).toEqual(EMPTY_SESSION_PICKS);
  });

  test('a malformed stored value is dropped rather than sent', () => {
    // These become request fields. A number `variant` would reach the runtime.
    expect(parseSessionPicks('{"model":1,"agent":true,"variant":{"x":1}}')).toEqual(
      EMPTY_SESSION_PICKS,
    );
    // A ModelKey is an OBJECT, never the wire string `modelKeyToWire` builds.
    // A half-written one must not reach sendParts as {providerID: undefined}.
    expect(parseSessionPicks('{"model":"anthropic/claude"}').model).toBeNull();
    expect(parseSessionPicks('{"model":{"providerID":"anthropic"}}').model).toBeNull();
    expect(parseSessionPicks('{"model":{"modelID":"claude"}}').model).toBeNull();
  });
});
