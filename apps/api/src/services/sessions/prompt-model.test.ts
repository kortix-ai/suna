/**
 * A re-pointed model pin must travel ON THE PROMPT.
 *
 * The model a turn runs lives in three places (see `prompt-model.ts`). #7957
 * converged the row's pin and the box's env; the turn still ran OpenCode's own
 * stored model and still died on the retired id. This pins the decision that
 * closes the third.
 */

import { describe, expect, test } from 'bun:test';

import { promptModelOverride } from './prompt-model';

describe('promptModelOverride', () => {
  const repointed = {
    opencode_model: 'kortix/deepseek-v4.1-flash',
    opencode_model_source: 'repointed',
    opencode_model_repointed_from: 'deepseek-v4-flash',
  };

  test('injects a repointed pin when the caller names no model', () => {
    // Without this the turn runs OpenCode's own stored model — the retired id
    // the re-point existed to escape.
    expect(promptModelOverride(null, repointed)).toEqual({
      providerID: 'kortix',
      modelID: 'deepseek-v4.1-flash',
    });
  });

  test("the caller's own model always wins", () => {
    expect(
      promptModelOverride({ providerID: 'anthropic', modelID: 'claude-sonnet-5' }, repointed),
    ).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
  });

  test('an EXPLICIT pin is not injected — a human chose it and the box was pushed', () => {
    // `PUT /model` writes `explicit` and pushes to the box itself. Injecting
    // here would keep overriding a model the user may since have changed.
    expect(
      promptModelOverride(null, {
        opencode_model: 'kortix/kimi-k3',
        opencode_model_source: 'explicit',
      }),
    ).toBeNull();
  });

  test('a PLATFORM pin is not injected — nothing was repaired', () => {
    expect(
      promptModelOverride(null, {
        opencode_model: 'kortix/kimi-k3',
        opencode_model_source: 'platform',
      }),
    ).toBeNull();
  });

  test('no metadata, no override', () => {
    expect(promptModelOverride(null, null)).toBeNull();
    expect(promptModelOverride(null, undefined)).toBeNull();
    expect(promptModelOverride(null, {})).toBeNull();
  });

  test('a malformed pin sends nothing rather than a broken ref', () => {
    for (const bad of ['', 42, null, 'kortix/']) {
      expect(
        promptModelOverride(null, { opencode_model: bad, opencode_model_source: 'repointed' }),
      ).toBeNull();
    }
  });

  test('a half-formed caller model falls through to the pin, never partially applied', () => {
    expect(promptModelOverride({ providerID: 'kortix' }, repointed)).toEqual({
      providerID: 'kortix',
      modelID: 'deepseek-v4.1-flash',
    });
  });
});
