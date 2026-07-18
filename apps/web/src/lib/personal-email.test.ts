import { describe, expect, test } from 'bun:test';

import { emailDomain, isPersonalEmail, isWorkEmail } from './personal-email';

describe('emailDomain', () => {
  test('extracts the lowercased domain', () => {
    expect(emailDomain('user@corp.com')).toBe('corp.com');
  });

  test('trims surrounding whitespace and lowercases', () => {
    expect(emailDomain('  Manager@CORP.COM  ')).toBe('corp.com');
  });

  test('uses the last @ so a multi-@ address resolves to its real domain', () => {
    expect(emailDomain('a@b@gmail.com')).toBe('gmail.com');
  });

  test('ignores plus-addressing in the local part', () => {
    expect(emailDomain('user+sales@acme-inc.com')).toBe('acme-inc.com');
  });

  test('returns null when there is no @', () => {
    expect(emailDomain('nodomain')).toBeNull();
  });

  test('returns null when the domain is empty', () => {
    expect(emailDomain('user@')).toBeNull();
  });

  test('returns null for empty, null, and undefined input', () => {
    expect(emailDomain('')).toBeNull();
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
  });
});

describe('isPersonalEmail', () => {
  test('flags well-known consumer providers regardless of case', () => {
    expect(isPersonalEmail('x@gmail.com')).toBe(true);
    expect(isPersonalEmail('X@GMAIL.COM')).toBe(true);
    expect(isPersonalEmail('x@outlook.com')).toBe(true);
    expect(isPersonalEmail('x@icloud.com')).toBe(true);
    expect(isPersonalEmail('x@proton.me')).toBe(true);
  });

  test('flags disposable providers', () => {
    expect(isPersonalEmail('x@mailinator.com')).toBe(true);
  });

  test('treats a multi-@ address by its final domain', () => {
    expect(isPersonalEmail('a@b@gmail.com')).toBe(true);
  });

  test('does not flag corporate domains', () => {
    expect(isPersonalEmail('x@corp.com')).toBe(false);
    expect(isPersonalEmail('x@acme-inc.com')).toBe(false);
  });

  test('returns false for unparseable input', () => {
    expect(isPersonalEmail('')).toBe(false);
    expect(isPersonalEmail(null)).toBe(false);
  });
});

describe('isWorkEmail', () => {
  test('routes a work-email domain (the domain SSO discovery probes)', () => {
    expect(isWorkEmail('manager@kortixssotest.com')).toBe(true);
    expect(isWorkEmail('ino@acme-inc.com')).toBe(true);
  });

  test('skiplists consumer providers so they are never probed', () => {
    expect(isWorkEmail('x@gmail.com')).toBe(false);
    expect(isWorkEmail('x@outlook.com')).toBe(false);
    expect(isWorkEmail('x@icloud.com')).toBe(false);
  });

  test('normalizes case and whitespace before deciding', () => {
    expect(isWorkEmail('  Manager@KortixSSOTest.com ')).toBe(true);
    expect(isWorkEmail('  X@GMAIL.COM ')).toBe(false);
  });

  test('a multi-@ address ending in a consumer domain is not a work email', () => {
    expect(isWorkEmail('a@b@gmail.com')).toBe(false);
  });

  test('is not a work email when the address is unparseable', () => {
    expect(isWorkEmail('user@')).toBe(false);
    expect(isWorkEmail('nodomain')).toBe(false);
    expect(isWorkEmail('')).toBe(false);
    expect(isWorkEmail(null)).toBe(false);
  });

  test('is the exact complement of isPersonalEmail for a parseable address', () => {
    for (const email of ['a@gmail.com', 'b@corp.com', 'c@kortixssotest.com', 'd@outlook.com']) {
      expect(isWorkEmail(email)).toBe(!isPersonalEmail(email));
    }
  });
});
