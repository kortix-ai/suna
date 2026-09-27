import { describe, expect, test } from 'bun:test';
import { type SavedTranscriptInput, resolveSavedTranscript } from './saved-transcript';

const base: SavedTranscriptInput = {
  enabled: true,
  hasMessages: false,
  history: 'off',
  mirror: 'idle',
  root: 'known',
};

describe('resolveSavedTranscript', () => {
  test('messages on screen are shown, whatever else is still resolving', () => {
    expect(resolveSavedTranscript({ ...base, hasMessages: true })).toBe('shown');
    expect(
      resolveSavedTranscript({ ...base, hasMessages: true, enabled: false, root: 'unknown' }),
    ).toBe('shown');
    expect(resolveSavedTranscript({ ...base, hasMessages: true, history: 'absent' })).toBe('shown');
  });

  test('a hook that has not started yet cannot rule a saved copy out', () => {
    expect(resolveSavedTranscript({ ...base, enabled: false, root: 'unknown' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, enabled: false, mirror: 'absent' })).toBe('loading');
  });

  test('with saved history on, the history read decides', () => {
    expect(resolveSavedTranscript({ ...base, history: 'loading' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, history: 'absent' })).toBe('none');
    expect(resolveSavedTranscript({ ...base, history: 'present', mirror: 'loading' })).toBe(
      'loading',
    );
    // The read found a copy, but the paint refused it (another root).
    expect(resolveSavedTranscript({ ...base, history: 'present', mirror: 'absent' })).toBe('none');
  });

  test('without saved history, the mirror paint decides once the root is known', () => {
    expect(resolveSavedTranscript({ ...base, mirror: 'idle' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, mirror: 'loading' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, mirror: 'absent' })).toBe('none');
  });

  test('a root still resolving waits; a root nothing can supply rules the copy out', () => {
    expect(resolveSavedTranscript({ ...base, root: 'pending' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, root: 'unknown' })).toBe('none');
    expect(resolveSavedTranscript({ ...base, root: 'unknown', history: 'loading' })).toBe(
      'loading',
    );
  });

  test('invariants hold for every input', () => {
    const histories = ['off', 'loading', 'present', 'absent'] as const;
    const mirrors = ['idle', 'loading', 'painted', 'absent'] as const;
    const roots = ['known', 'pending', 'unknown'] as const;
    let cases = 0;
    for (const enabled of [true, false])
      for (const hasMessages of [true, false])
        for (const history of histories)
          for (const mirror of mirrors)
            for (const root of roots) {
              const input = { enabled, hasMessages, history, mirror, root };
              const answer = resolveSavedTranscript(input);
              cases++;
              // `shown` exactly when there is something to show.
              expect(answer === 'shown').toBe(hasMessages);
              // Nothing is ruled out before the hook runs.
              if (!enabled && !hasMessages) expect(answer).toBe('loading');
              // A read still in flight never rules the copy out.
              if (enabled && !hasMessages && history === 'loading') expect(answer).toBe('loading');
              // A history read that found nothing always rules it out.
              if (enabled && !hasMessages && history === 'absent') expect(answer).toBe('none');
              // A root still resolving is "not yet", never "no".
              if (enabled && !hasMessages && root === 'pending' && history !== 'absent')
                expect(answer).toBe('loading');
            }
    expect(cases).toBe(2 * 2 * 4 * 4 * 3);
  });
});
