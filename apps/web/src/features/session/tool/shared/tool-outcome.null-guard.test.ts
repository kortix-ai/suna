import { describe, expect, test } from 'bun:test';

import {
  cleanErrorMessage,
  formatJsonFailureOutput,
  isErrorOutput,
  looksLikeError,
  parseJsonFailure,
  partOutcome,
} from '@/features/session/tool/shared/tool-outcome';
import type { ToolPart } from '@/ui';

function part(state: Record<string, unknown>): Pick<ToolPart, 'state'> {
  return { state } as unknown as Pick<ToolPart, 'state'>;
}

/**
 * Regression for Better Stack patterns `487ae241…` / `ce68779d…` (prod v0.12.4):
 * `Cannot read properties of null (reading 'success')` thrown from the session
 * page's turn render.
 *
 * Root cause: a tool whose completed `state.output` is the JSON literal `null`
 * (or any JSON value that parses to a non-object) reached
 * `parseJsonFailure`/`formatJsonFailureOutput`, which cast the parsed value to
 * `Record<string, unknown>` and read `.success` on it — but `JSON.parse('null')`
 * is `null`, so `null.success` threw. The throw bubbled up through
 * `isErrorOutput` → `partOutcome` → `burstFailureCount`'s `useMemo`+`filter`
 * (the `ActivityBurst` failure tally) and crashed the React tree for the
 * whole session view.
 *
 * Every JSON value that is NOT a plain object is, by definition, not the
 * `{success:false,error}` failure contract, so the parsers now return `null`
 * for it instead of dereferencing it. These tests pin that contract.
 */
describe('tool-outcome null/non-object JSON guard', () => {
  test('parseJsonFailure does not throw on the literal null', () => {
    expect(parseJsonFailure('null')).toBeNull();
  });

  test('parseJsonFailure does not throw on other non-object JSON', () => {
    expect(parseJsonFailure('true')).toBeNull();
    expect(parseJsonFailure('false')).toBeNull();
    expect(parseJsonFailure('42')).toBeNull();
    expect(parseJsonFailure('"just a string"')).toBeNull();
    // An array is not the failure contract either.
    expect(parseJsonFailure('[]')).toBeNull();
  });

  test('formatJsonFailureOutput does not throw on the literal null', () => {
    expect(formatJsonFailureOutput('null')).toBeNull();
  });

  test('formatJsonFailureOutput does not throw on other non-object JSON', () => {
    expect(formatJsonFailureOutput('true')).toBeNull();
    expect(formatJsonFailureOutput('42')).toBeNull();
    expect(formatJsonFailureOutput('[]')).toBeNull();
  });

  test('isErrorOutput treats the literal null as not an error (and does not throw)', () => {
    expect(isErrorOutput('null')).toBe(false);
    expect(isErrorOutput('true')).toBe(false);
    expect(isErrorOutput('42')).toBe(false);
  });

  test('partOutcome on a completed tool that returned the literal null is ok (and does not throw)', () => {
    // This is the exact prod path: ActivityBurst's `burstFailureCount` useMemo
    // filters parts through partOutcome, which reads state.output.
    expect(partOutcome(part({ status: 'completed', output: 'null' }))).toBe('ok');
    expect(partOutcome(part({ status: 'completed', output: 'true' }))).toBe('ok');
    expect(partOutcome(part({ status: 'completed', output: '[]' }))).toBe('ok');
  });
});

describe('tool-outcome failure contract still recognized (no regression)', () => {
  test('parseJsonFailure extracts the {success:false,error} contract', () => {
    const failure = parseJsonFailure('{"success":false,"error":"Error: boom"}');
    expect(failure).not.toBeNull();
    expect(cleanErrorMessage(failure!.errorSummary)).toBe('boom');
  });

  test('parseJsonFailure returns null for a successful payload', () => {
    expect(parseJsonFailure('{"success":true}')).toBeNull();
  });

  test('formatJsonFailureOutput formats the failure contract', () => {
    // formatJsonFailureOutput returns the raw error (the card cleans it later).
    const out = formatJsonFailureOutput('{"success":false,"error":"Error: boom"}');
    expect(out).toBe('Error: boom');
  });

  test('looksLikeError still detects plain errors', () => {
    expect(looksLikeError('Error: something failed')).toBe(true);
    expect(looksLikeError('null')).toBe(false);
  });

  test('partOutcome still flags a returned failure contract as failed', () => {
    expect(
      partOutcome(part({ status: 'completed', output: '{"success":false,"error":"Error: boom"}' })),
    ).toBe('failed');
  });
});
