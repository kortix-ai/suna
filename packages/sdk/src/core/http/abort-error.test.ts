import { describe, expect, test } from 'bun:test';
import {
  ABORT_REASONS,
  ABORT_REASONS_NOT_YET_EMITTED,
  abortErrorReason,
  isAbortError,
  type AbortReason,
} from './abort-error';

describe('isAbortError', () => {
  test('nullish / non-object, non-string input is never an abort', () => {
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });

  // The client-synthesized marker `applyOptimisticAbort` / `markSessionAbortedLocally`
  // patch onto a message when the user hits Stop (see `SyntheticAbortError`,
  // `use-session-send.ts:279-304`, `use-event-stream-refs.ts:113-135`).
  test('the SDK-synthesized abort marker is identified by name', () => {
    expect(isAbortError({ name: 'AbortError', data: { message: 'The operation was aborted.' } })).toBe(
      true,
    );
  });

  // The real opencode wire shape for an aborted turn (`AssistantMessage.error`
  // union member, `@opencode-ai/sdk` `types.gen.d.ts`).
  test('the real opencode wire abort error is identified by name', () => {
    expect(
      isAbortError({ name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } }),
    ).toBe(true);
  });

  // A DOMException thrown by a real `fetch`/`AbortController` abort — `.name`
  // is an accessor property, not an own field, so bracket access must still see it.
  test('a DOMException-shaped AbortError is identified by name', () => {
    expect(isAbortError(new DOMException('The user aborted a request.', 'AbortError'))).toBe(true);
  });

  test('an unrelated named error is not an abort', () => {
    expect(isAbortError({ name: 'ProviderError', data: { message: 'boom' } })).toBe(false);
    expect(isAbortError(new Error('random failure'))).toBe(false);
  });

  // No identity match — last-resort sniff of the error's OWN nested text.
  // Mirrors `run-outcome.test.ts`'s "abort error → stopped, by name or by
  // message text" case: some producers carry an abort-ish message under an
  // unrelated/unknown `name`.
  test('falls back to sniffing data.message when the name does not match', () => {
    expect(
      isAbortError({ name: 'UnknownError', data: { message: 'The operation was aborted' } }),
    ).toBe(true);
  });

  test('a bare abort-ish string is recognized (last resort for prose-only callers)', () => {
    expect(isAbortError('The operation was aborted by user')).toBe(true);
    expect(isAbortError('Request was cancelled')).toBe(true);
    expect(isAbortError('AbortError: stream closed')).toBe(true);
  });

  // The bug `looksLikeAbortText` was written to fix: a transport failure that
  // merely MENTIONS "aborted" must not be mislabeled as a user-initiated stop.
  test('a transport failure that mentions "aborted" is NOT an abort', () => {
    expect(
      isAbortError('upstream unreachable: fetch failed — The operation was aborted'),
    ).toBe(false);
    expect(isAbortError('gateway timeout (504)')).toBe(false);
    expect(isAbortError('socket hang up')).toBe(false);
  });

  test('an unrelated plain string is not an abort', () => {
    expect(isAbortError('insufficient credits')).toBe(false);
    expect(isAbortError('')).toBe(false);
  });
});

describe('abortErrorReason', () => {
  test('nullish / non-object input has no reason', () => {
    expect(abortErrorReason(undefined)).toBeUndefined();
    expect(abortErrorReason(null)).toBeUndefined();
    expect(abortErrorReason('a bare string')).toBeUndefined();
  });

  test('surfaces data.reason when present', () => {
    expect(
      abortErrorReason({
        name: 'AbortError',
        data: { message: 'runtime disposed', reason: 'runtime-disposed' },
      }),
    ).toBe('runtime-disposed');
  });

  test('returns undefined when data carries no reason yet', () => {
    expect(abortErrorReason({ name: 'AbortError', data: { message: 'x' } })).toBeUndefined();
  });

  test('ignores a non-string reason', () => {
    expect(
      abortErrorReason({ name: 'AbortError', data: { message: 'x', reason: 123 } }),
    ).toBeUndefined();
  });

  // F4 review finding: the doc comment promises a closed union, but the old
  // implementation returned ANY non-empty string verbatim — an unknown/
  // typo'd reason would silently reach a renderer that branches on
  // `reason === 'user'` and suppress the "Interrupted" row for every other
  // value, including one nobody ever intended. Membership must be validated
  // against `ABORT_REASONS`; an unrecognized string is not "a new reason
  // that happens to work", it's a bug upstream, and the safe default is
  // `undefined` (renders like a reason-less real wire abort).
  test('rejects a reason string that is not a member of the closed ABORT_REASONS union', () => {
    expect(
      abortErrorReason({ name: 'AbortError', data: { message: 'x', reason: 'not-a-real-reason' } }),
    ).toBeUndefined();
  });
});

// T2: the closed reason union both real producers stamp into
// `data.reason` — `applyOptimisticAbort` ('user') and
// `markSessionAbortedLocally` ('runtime-disposed') — plus the two
// not-yet-produced members declared ahead of their own follow-up work
// (mirrors `apps/api/src/projects/stop-reason.ts`'s
// `STOP_REASONS_NOT_YET_EMITTED` pattern).
describe('ABORT_REASONS', () => {
  test("declares 'user' and 'runtime-disposed' as the two currently-emitted reasons", () => {
    expect(ABORT_REASONS).toContain('user');
    expect(ABORT_REASONS).toContain('runtime-disposed');
  });

  test('ABORT_REASONS_NOT_YET_EMITTED is a subset of ABORT_REASONS, and excludes the live producers', () => {
    for (const reason of ABORT_REASONS_NOT_YET_EMITTED) {
      expect(ABORT_REASONS).toContain(reason);
    }
    expect(ABORT_REASONS_NOT_YET_EMITTED).not.toContain('user');
    expect(ABORT_REASONS_NOT_YET_EMITTED).not.toContain('runtime-disposed');
  });

  test('abortErrorReason reads a value straight out of the closed union', () => {
    const reason: AbortReason = 'runtime-disposed';
    expect(
      abortErrorReason({ name: 'AbortError', data: { message: 'x', reason } }),
    ).toBe('runtime-disposed');
  });
});
