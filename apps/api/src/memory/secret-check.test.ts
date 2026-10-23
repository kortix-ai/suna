import { describe, expect, test } from 'bun:test';
import { findSecret } from './secret-check';

describe('secret check', () => {
  test.each([
    ['a bearer token', 'Authorization: Bearer abc.def.ghi'],
    ['an OpenAI-style key', 'the key is sk-proj-1234567890abcdef'],
    ['a GitHub token', 'ghp_1234567890abcdefghij'],
    ['a Kortix token', 'kortix_pat_abc123'],
    ['a key=value pair', 'password=hunter22'],
    ['an AWS access key', 'AKIAABCDEFGHIJKLMNOP'],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl'],
    ['a chat bot token', 'xoxb-1234567890-abcdefghij'],
    ['a Google API key', `AIza${'A'.repeat(35)}`],
  ])('%s is a secret', (_name, text) => {
    expect(findSecret(text)).toBe(true);
  });

  test('prose about tokens and passwords is not', () => {
    expect(findSecret('Rotate the API token every month; the password policy is in the playbook.')).toBe(false);
    expect(findSecret('Priya owns the token budget for Northwind.')).toBe(false);
  });
});
