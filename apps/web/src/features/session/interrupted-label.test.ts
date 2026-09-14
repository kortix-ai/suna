/**
 * An interrupted turn must render NOTHING, and a real failure must still be
 * shown.
 *
 * A stop is something the user asked for — from the Stop button, from another
 * tab, or (for `'runtime-disposed'`) from a runtime that respawned under them.
 * None of those are news, so the transcript stays clean. That makes the abort
 * classification the load-bearing part: anything misread as an abort is now
 * silently swallowed, so a genuine failure whose prose merely contains
 * "aborted" must never be classified as one.
 *
 * T17: this file used to assert on the SOURCE TEXT of
 * `session-error-banner.tsx` / `session-chat.tsx` (`expect(code(BANNER)).toContain(...)`).
 * That style cannot fail on a real regression: a caller can satisfy every
 * string check while shipping broken behavior (e.g. keep the substring
 * `isAbort ?? isAbortError(text)` present but dead-code it), and — see
 * `apps/web`'s documented source-assertion trap — a refactor that keeps the
 * exact wording but changes the logic slips through untouched. Replaced with
 * BEHAVIOR tests:
 *
 *  1. `TurnErrorDisplay` (`session-error-banner.tsx`), rendered for real via
 *     `renderToStaticMarkup` (this repo has no DOM harness — see
 *     `session-error-banner-abort.test.tsx`, which this file's render matrix
 *     deliberately mirrors rather than duplicates in full).
 *  2. `deriveTurnErrorAbortState` (`session-chat.tsx`) — the wiring seam that
 *     computes `isAbort` from a turn's assistant messages before passing it to
 *     the banner. It used to be an inline, untestable `useMemo` loop; exported
 *     (no behavior change — see the comment at its definition) so this file can
 *     exercise the real derivation with realistic message fixtures instead of
 *     grepping for its source.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { deriveTurnErrorAbortState } from './session-chat';
import { TurnErrorDisplay } from './session-error-banner';

// This file is `.ts`, not `.tsx` (filename is pinned — see T17), so
// JSX syntax is unavailable; `createElement` renders the exact same tree.
// No `NextIntlClientProvider` wrapper needed: every scenario below renders
// nothing or the plain error card, neither of which call `useTranslations`
// (only the billing/usage-limit cards do — see
// `session-error-banner-abort.test.tsx` for those, which DOES need the
// provider).
const render = (props: Parameters<typeof TurnErrorDisplay>[0]) =>
  renderToStaticMarkup(createElement(TurnErrorDisplay, props));

// ============================================================================
// 1. TurnErrorDisplay render matrix.
// ============================================================================

describe('TurnErrorDisplay — an abort renders nothing, whatever its reason', () => {
  test('a user Stop renders nothing at all — no Interrupted row', () => {
    const markup = render({ errorText: 'The operation was aborted.', isAbort: true });
    expect(markup.trim()).toBe('');
  });

  test('an infra respawn (runtime-disposed) renders nothing at all', () => {
    const markup = render({
      errorText: 'The operation was aborted because the runtime shut down.',
      isAbort: true,
    });
    expect(markup.trim()).toBe('');
  });

  test('an abort recognized from prose alone (no isAbort prop) renders nothing', () => {
    // The caller could not classify it, so the SDK's last-resort text sniff
    // over `text` decides. Still an abort, still silent.
    const markup = render({ errorText: 'The operation was aborted.' });
    expect(markup.trim()).toBe('');
  });

  test('non-abort error: the error card still renders, never swallowed', () => {
    // A plain gateway failure, not a billing/usage-limit one — those render a
    // dedicated card that needs `useTranslations`, covered separately by
    // `session-error-banner-abort.test.tsx` under its intl provider.
    const markup = render({ errorText: 'upstream unreachable: socket hang up', isAbort: false });
    expect(markup).not.toContain('Interrupted');
    expect(markup).toContain('upstream unreachable');
  });
});

// ============================================================================
// 2. deriveTurnErrorAbortState — the session-chat.tsx wiring seam.
// ============================================================================

/** Build a minimal turn with a single assistant message carrying `error`. */
function turnWithError(error: unknown) {
  return { assistantMessages: [{ info: { error } }] };
}

describe('deriveTurnErrorAbortState — the wiring that feeds TurnErrorDisplay', () => {
  test('a real user Stop (applyOptimisticAbort): AbortError + reason "user"', () => {
    const turn = turnWithError({
      name: 'AbortError',
      data: { message: 'stopped', reason: 'user' },
    });
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: true });
  });

  test('an infra respawn (markSessionAbortedLocally): AbortError + reason "runtime-disposed"', () => {
    const turn = turnWithError({
      name: 'AbortError',
      data: { message: 'runtime disposed', reason: 'runtime-disposed' },
    });
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: true });
  });

  test('a genuine opencode wire abort (MessageAbortedError): identity true', () => {
    const turn = turnWithError({ name: 'MessageAbortedError', data: { message: 'aborted' } });
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: true });
  });

  test('a genuine failure whose prose merely contains "aborted": NOT an abort', () => {
    const turn = turnWithError({
      name: 'Error',
      data: { message: 'upstream unreachable: The operation was aborted.' },
    });
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: false });
  });

  test('no error on any message: not an abort', () => {
    const turn = { assistantMessages: [{ info: {} }, { info: { error: undefined } }] };
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: false });
  });

  test('reads the FIRST message carrying an error, matching getTurnError', () => {
    const turn = {
      assistantMessages: [
        { info: {} },
        { info: { error: { name: 'Error', data: { message: 'upstream unreachable' } } } },
        { info: { error: { name: 'MessageAbortedError', data: { message: 'later' } } } },
      ],
    };
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: false });
  });

  test('end to end: a stopped turn renders nothing, a failed turn still renders', () => {
    const userTurn = turnWithError({
      name: 'AbortError',
      data: { message: 'stopped', reason: 'user' },
    });
    expect(render({ errorText: 'stopped', ...deriveTurnErrorAbortState(userTurn) }).trim()).toBe(
      '',
    );

    const failedTurn = turnWithError({
      name: 'Error',
      data: { message: 'upstream unreachable: The operation was aborted.' },
    });
    const failedState = deriveTurnErrorAbortState(failedTurn);
    expect(render({ errorText: 'upstream unreachable', ...failedState })).toContain(
      'upstream unreachable',
    );
  });
});
