// A 5xx THE AGENT MEANT MUST NOT BE RETRIED FOUR TIMES.
import { describe, expect, test } from 'bun:test';
import { UPSTREAM_FINAL_HEADER, upstreamAnsweredFinally } from './upstream-final';

const h = (v?: string) => {
  const x = new Headers();
  if (v !== undefined) x.set(UPSTREAM_FINAL_HEADER, v);
  return x;
};

describe('a final upstream answer', () => {
  test('is recognised when the agent marks it', () => {
    expect(upstreamAnsweredFinally(h('1'))).toBe(true);
  });

  test('is NOT assumed for an ordinary 5xx — a cold port still gets its retries', () => {
    expect(upstreamAnsweredFinally(h())).toBe(false);
    expect(upstreamAnsweredFinally(new Headers())).toBe(false);
    expect(upstreamAnsweredFinally(null)).toBe(false);
    expect(upstreamAnsweredFinally(undefined)).toBe(false);
  });

  test('an explicit "0" means not final, so the header can be sent unconditionally', () => {
    expect(upstreamAnsweredFinally(h('0'))).toBe(false);
  });

  test('a blank value is not a claim', () => {
    expect(upstreamAnsweredFinally(h(''))).toBe(false);
    expect(upstreamAnsweredFinally(h('   '))).toBe(false);
  });

  test('any other non-empty value counts — the header is a flag, not a vocabulary', () => {
    expect(upstreamAnsweredFinally(h('yes'))).toBe(true);
  });
});
