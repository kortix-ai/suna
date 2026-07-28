import { describe, expect, test } from 'bun:test';
import { resolveEndUserRef } from './end-user-ref';

describe('resolveEndUserRef — end_user_ref with origin_ref as a deprecated alias', () => {
  test('accepts the new name', () => {
    const r = resolveEndUserRef({ end_user_ref: 'user-123' });
    expect(r).toEqual({ ok: true, value: 'user-123', suppliedUnder: 'end_user_ref' });
  });

  test('still accepts the deprecated alias — live wrappers must not break', () => {
    const r = resolveEndUserRef({ origin_ref: 'user-123' });
    expect(r).toEqual({ ok: true, value: 'user-123', suppliedUnder: 'origin_ref' });
  });

  test('both spellings are fine when they agree (a client mid-migration)', () => {
    const r = resolveEndUserRef({ end_user_ref: 'user-123', origin_ref: 'user-123' });
    expect(r.ok).toBe(true);
  });

  test('rejects disagreeing spellings rather than silently picking one', () => {
    // Preferring either would misattribute every usage row for the session, and
    // the caller could not tell which had won.
    const r = resolveEndUserRef({ end_user_ref: 'alice', origin_ref: 'bob' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('END_USER_REF_CONFLICT');
  });

  test('trims, and treats differing-but-equivalent whitespace as agreement', () => {
    expect(resolveEndUserRef({ end_user_ref: '  user-1  ' })).toMatchObject({ value: 'user-1' });
    expect(resolveEndUserRef({ end_user_ref: 'u', origin_ref: ' u ' }).ok).toBe(true);
  });

  test('absent → null, and nothing was supplied', () => {
    expect(resolveEndUserRef({})).toEqual({ ok: true, value: null, suppliedUnder: null });
  });

  test('a whitespace-only handle still counts as SUPPLIED for the origin gate', () => {
    // Otherwise a non-backend caller sends "   " and slips past the 403, because
    // the value normalises to null before the gate sees it.
    const r = resolveEndUserRef({ end_user_ref: '   ' });
    expect(r).toEqual({ ok: true, value: null, suppliedUnder: 'end_user_ref' });
  });

  test('a non-string is ignored rather than coerced', () => {
    expect(resolveEndUserRef({ end_user_ref: 42 as unknown })).toEqual({
      ok: true,
      value: null,
      suppliedUnder: null,
    });
  });
});
