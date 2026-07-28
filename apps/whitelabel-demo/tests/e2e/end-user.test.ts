import { describe, expect, test } from 'bun:test';
import { injectEndUserRef, isSessionCreate } from '../../src/server/end-user';

describe('isSessionCreate', () => {
  test('matches only a session create', () => {
    expect(isSessionCreate('POST', 'projects/p1/sessions')).toBe(true);
    expect(isSessionCreate('POST', 'projects/p1/sessions/')).toBe(true);
  });

  test('does not match reads, or nested session routes', () => {
    expect(isSessionCreate('GET', 'projects/p1/sessions')).toBe(false);
    expect(isSessionCreate('POST', 'projects/p1/sessions/s1/model')).toBe(false);
    expect(isSessionCreate('POST', 'projects/p1/secrets')).toBe(false);
  });
});

describe('injectEndUserRef', () => {
  test('stamps the signed-in user onto a session create', () => {
    const result = injectEndUserRef({ name: 'hello' }, 'lumen-user-1');
    expect(result.action).toBe('inject');
    if (result.action === 'inject') {
      expect(result.body.end_user_ref).toBe('lumen-user-1');
      expect(result.body.name).toBe('hello');
    }
  });

  test('REJECTS a client claiming to be someone else', () => {
    // Silently overwriting would hide the attempt. Per-end-user billing and
    // idempotency-replay protection both key on this value.
    const result = injectEndUserRef({ end_user_ref: 'someone-else' }, 'lumen-user-1');
    expect(result.action).toBe('reject');
  });

  test('rejects the deprecated origin_ref alias just as firmly', () => {
    expect(injectEndUserRef({ origin_ref: 'someone-else' }, 'me').action).toBe('reject');
  });

  test('a client echoing its OWN id is fine, not punished', () => {
    expect(injectEndUserRef({ end_user_ref: 'me' }, 'me').action).toBe('inject');
  });

  test('drops the legacy alias so upstream never sees both spellings', () => {
    const result = injectEndUserRef({ origin_ref: 'me', name: 'x' }, 'me');
    if (result.action === 'inject') {
      expect(result.body.end_user_ref).toBe('me');
      expect(result.body.origin_ref).toBeUndefined();
    }
  });

  test('a non-object body passes through untouched', () => {
    expect(injectEndUserRef(null, 'me').action).toBe('passthrough');
    expect(injectEndUserRef([1, 2], 'me').action).toBe('passthrough');
  });

  test('a blank claim is not treated as an impersonation attempt', () => {
    expect(injectEndUserRef({ end_user_ref: '   ' }, 'me').action).toBe('inject');
  });
});
