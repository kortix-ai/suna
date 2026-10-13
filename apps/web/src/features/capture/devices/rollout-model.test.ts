import { describe, expect, test } from 'bun:test';

import { enrollmentUrl, msiCommand, parseDomains, parseLimit, personLabel } from './rollout-model';

describe('IT rollout model', () => {
  test('domains: any separator, a leading @, any case, no duplicates', () => {
    expect(parseDomains(' @Corp.example, corp.example\nlab.corp.example;  ')).toEqual(['corp.example', 'lab.corp.example']);
    expect(parseDomains('')).toEqual([]);
  });

  test('the enrollment URL is the API origin without /v1', () => {
    expect(enrollmentUrl('https://api.kortix.com/v1')).toBe('https://api.kortix.com');
    expect(enrollmentUrl('http://localhost:8008/v1/')).toBe('http://localhost:8008');
    expect(enrollmentUrl('https://kortix.example/api')).toBe('https://kortix.example/api');
    expect(enrollmentUrl(undefined)).toBe('https://api.kortix.com');
  });

  test('the silent install names the URL and the token', () => {
    expect(msiCommand('https://api.kortix.com', 'kortix_enr_x')).toBe(
      'msiexec /i KortixCapture.msi /qn KORTIX_URL=https://api.kortix.com ENROLLMENT_TOKEN=kortix_enr_x',
    );
  });

  test('a computer limit is a whole number from 1, else no limit', () => {
    expect(parseLimit('20')).toBe(20);
    expect(parseLimit(' ')).toBeNull();
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('2.5')).toBeNull();
  });

  test('a waiting computer names its UPN, else its login name', () => {
    expect(personLabel({ principal_name: 'a@corp.example', account_name: 'CORP\\a' })).toBe('a@corp.example');
    expect(personLabel({ principal_name: null, account_name: 'CORP\\a' })).toBe('CORP\\a');
  });
});
