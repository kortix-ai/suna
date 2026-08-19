/**
 * "Interrupted" must mean the turn was actually interrupted.
 *
 * The label is a muted one-liner that REPLACES the error card. So mislabelling
 * costs twice: the user is told they stopped something they didn't, and the
 * real failure is never shown.
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
 *     deliberately mirrors rather than duplicates in full) — across the
 *     reason-gate matrix.
 *  2. `deriveTurnErrorAbortState` (`session-chat.tsx`) — the wiring seam that
 *     computes `isAbort`/`abortReason` from a turn's assistant messages before
 *     passing them to the banner. It used to be two inline, untestable
 *     `useMemo` loops; exported (no behavior change — see the comment at its
 *     definition) so this file can exercise the real derivation with
 *     realistic message fixtures instead of grepping for its source.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { deriveTurnErrorAbortState } from './session-chat';
import { TurnErrorDisplay } from './session-error-banner';

// This file is `.ts`, not `.tsx` (filename is pinned — see T17), so
// JSX syntax is unavailable; `createElement` renders the exact same tree.
// No `NextIntlClientProvider` wrapper needed: every scenario below renders
// the abort row or the plain error card, neither of which call
// `useTranslations` (only the billing/usage-limit cards do — see
// `session-error-banner-abort.test.tsx` for those, which DOES need the
// provider).
const render = (props: Parameters<typeof TurnErrorDisplay>[0]) =>
  renderToStaticMarkup(createElement(TurnErrorDisplay, props));

// ============================================================================
// 1. TurnErrorDisplay render matrix — the four cases T17 asks for.
// ============================================================================

describe('TurnErrorDisplay — reason-gated render matrix', () => {
  test('user-reason abort: the Interrupted row is present', () => {
    const markup = render({
      errorText: 'The operation was aborted.',
      isAbort: true,
      abortReason: 'user',
    });
    expect(markup).toContain('Interrupted');
  });

  test('runtime-disposed reason: renders nothing at all', () => {
    const markup = render({
      errorText: 'The operation was aborted because the runtime shut down.',
      isAbort: true,
      abortReason: 'runtime-disposed',
    });
    expect(markup.trim()).toBe('');
  });

  test('untagged abort (no reason): the Interrupted row is present', () => {
    const markup = render({
      errorText: 'The operation was aborted.',
      isAbort: true,
      abortReason: undefined,
    });
    expect(markup).toContain('Interrupted');
  });

  test('non-abort error: an error card renders, never the Interrupted row', () => {
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
    const turn = turnWithError({ name: 'AbortError', data: { message: 'stopped', reason: 'user' } });
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: true, abortReason: 'user' });
  });

  test('an infra respawn (markSessionAbortedLocally): AbortError + reason "runtime-disposed"', () => {
    const turn = turnWithError({
      name: 'AbortError',
      data: { message: 'runtime disposed', reason: 'runtime-disposed' },
    });
    expect(deriveTurnErrorAbortState(turn)).toEqual({
      isAbort: true,
      abortReason: 'runtime-disposed',
    });
  });

  test('a genuine opencode wire abort (MessageAbortedError): identity true, reason undefined', () => {
    const turn = turnWithError({ name: 'MessageAbortedError', data: { message: 'aborted' } });
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: true, abortReason: undefined });
  });

  test('a genuine failure whose prose merely contains "aborted": NOT an abort', () => {
    const turn = turnWithError({
      name: 'Error',
      data: { message: 'upstream unreachable: The operation was aborted.' },
    });
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: false, abortReason: undefined });
  });

  test('no error on any message: not an abort, no reason', () => {
    const turn = { assistantMessages: [{ info: {} }, { info: { error: undefined } }] };
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: false, abortReason: undefined });
  });

  test('reads the FIRST message carrying an error, matching getTurnError', () => {
    const turn = {
      assistantMessages: [
        { info: {} },
        { info: { error: { name: 'AbortError', data: { message: 'stopped', reason: 'user' } } } },
        { info: { error: { name: 'MessageAbortedError', data: { message: 'later' } } } },
      ],
    };
    expect(deriveTurnErrorAbortState(turn)).toEqual({ isAbort: true, abortReason: 'user' });
  });

  test('end to end: the derived state renders exactly what TurnErrorDisplay would show', () => {
    const infraTurn = turnWithError({
      name: 'AbortError',
      data: { message: 'runtime disposed', reason: 'runtime-disposed' },
    });
    const { isAbort, abortReason } = deriveTurnErrorAbortState(infraTurn);
    expect(render({ errorText: 'runtime disposed', isAbort, abortReason }).trim()).toBe('');

    const userTurn = turnWithError({ name: 'AbortError', data: { message: 'stopped', reason: 'user' } });
    const userState = deriveTurnErrorAbortState(userTurn);
    expect(render({ errorText: 'stopped', ...userState })).toContain('Interrupted');
  });
});
