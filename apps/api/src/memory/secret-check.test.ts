import { describe, expect, test } from 'bun:test';
import { findSecret } from './secret-check';

describe('secret check', () => {
  test.each([
    ['an OpenAI-style key', 'the key is sk-proj-1234567890abcdefXYZ'],
    ['a Stripe key', `sk_${'live'}_51HqLyjWDarjtT1zdp7dc`],
    ['an AWS access key', `AKIA${'ABCDEFGHIJKLMNOP'}`],
    ['an AWS session key', `ASIA${'ABCDEFGHIJKLMNOP'}`],
    ['a GitHub token', `ghp_${'1234567890abcdefghijABCDEFGHIJ123456'}`],
    ['a GitHub fine-grained token', `github_pat_${'11ABCDEFG0123456789_abcdefghijklmnop'}`],
    ['a chat bot token', `xoxb-${'1234567890'}-abcdefghij`],
    ['a Google API key', `AIza${'A1b2'.repeat(8)}abc`],
    ['a Kortix token', `kortix_pat_${'abc12345'}`],
    ['a bearer token', 'Authorization: Bearer abc123def456ghi789jkl'],
    ['a JWT', `eyJhbGciOiJIUzI1NiJ9.${'eyJzdWIiOiIxMjM0NTY3ODkwIn0'}.c2lnbmF0dXJlLXBhcnQ`],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['a password assignment', 'password=hunter22'],
    ['a token assignment', 'token = "abc123xyz"'],
    ['a long random token', 'use Zx9Qm2Lp7Rt4Vw8Ky1Bn6Hd3Fg5Js0Ac here'],
  ])('%s is a secret', (_name, text) => {
    expect(findSecret(text)).toBe(true);
  });

  test.each([
    'See the risk-management-framework doc.',
    'Our task-assignment-overview page',
    'Use desk-reservations-calendar',
    'He was the bearer of bad news.',
    'The password reset flow ships Friday.',
    'Rotate the API token every month; the password policy is in the playbook.',
    'Priya owns the token budget for Northwind.',
    'Page 2c53bf77-a77d-4e60-aad8-f86d616a6273 moved.',
    'The build hash is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'Rename MemoryLayerExportSchemaValidation2 later.',
    'https://example.com/Northwind/Launch2026/plans/Q4Roadmap/Overview',
  ])('"%s" is not a secret', (text) => {
    expect(findSecret(text)).toBe(false);
  });
});
