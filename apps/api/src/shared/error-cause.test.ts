import { describe, expect, test } from 'bun:test';
import { errorSqlstate, innermostMessage } from './error-cause';

describe('errorSqlstate', () => {
  test('finds the driver SQLSTATE under a wrapper that has none', () => {
    const driver = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    expect(errorSqlstate(Object.assign(new Error('Failed query: …'), { cause: driver }))).toBe(
      '40P01',
    );
  });

  // Production behaviour, preserved on purpose: this decides whether an audit
  // write is retried, so the outer code wins when a thrower synthesises one.
  test('takes the FIRST code, not the deepest', () => {
    const inner = Object.assign(new Error('inner'), { code: '57014' });
    const outer = Object.assign(new Error('outer'), { code: 'CONNECTION_CLOSED', cause: inner });
    expect(errorSqlstate(outer)).toBe('CONNECTION_CLOSED');
  });

  test('is null when nothing on the chain carries a code', () => {
    expect(errorSqlstate(new Error('boom'))).toBeNull();
    expect(errorSqlstate(null)).toBeNull();
    expect(errorSqlstate('a string')).toBeNull();
  });
});

describe('innermostMessage', () => {
  test('returns the driver message, not the wrapper SQL', () => {
    const driver = new Error('canceling statement due to statement timeout');
    const wrapper = Object.assign(new Error('Failed query: insert into …'), { cause: driver });
    expect(innermostMessage(wrapper)).toBe('canceling statement due to statement timeout');
  });

  test('falls back to the outer message when there is no cause', () => {
    expect(innermostMessage(new Error('lonely'))).toBe('lonely');
  });

  test('is null when there is no message anywhere', () => {
    expect(innermostMessage({})).toBeNull();
    expect(innermostMessage(null)).toBeNull();
  });
});

// A cause cycle is a hang, and these run on an error path where a hang is worse
// than a missing detail.
describe('cycle and depth safety', () => {
  test('a self-referential cause terminates', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a;
    expect(innermostMessage(a)).toBe('a');
    expect(errorSqlstate(a)).toBeNull();
  });

  test('a two-node cycle terminates', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = Object.assign(new Error('b'), { code: '23505' }) as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(errorSqlstate(a)).toBe('23505');
    expect(innermostMessage(a)).toBe('b');
  });

  test('a chain longer than the bound still returns something', () => {
    let node = new Error('leaf') as Error & { cause?: unknown };
    for (let i = 0; i < 50; i++) node = Object.assign(new Error(`link-${i}`), { cause: node });
    expect(innermostMessage(node)).toContain('link-');
  });
});
