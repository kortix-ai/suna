import { beforeEach, describe, expect, test } from 'bun:test';
import { restrictedAuthDecision } from './nonprod-access';

const ENV_KEYS = [
  'KORTIX_AUTH_ACCESS_MODE',
  'KORTIX_AUTH_ALLOWED_EMAILS',
  'KORTIX_AUTH_ALLOWED_EMAIL_DOMAINS',
  'KORTIX_PUBLIC_APP_URL',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_URL',
  'PUBLIC_URL',
  'VERCEL_URL',
];

describe('restrictedAuthDecision', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test('leaves production and local auth open by default', () => {
    expect(
      restrictedAuthDecision({
        email: 'someone@example.com',
        origin: 'https://kortix.com',
      }).allowed,
    ).toBe(true);
    expect(
      restrictedAuthDecision({
        email: 'someone@example.com',
        origin: 'http://localhost:3000',
      }).allowed,
    ).toBe(true);
  });

  test('restricts dev and staging hosts by default', () => {
    expect(
      restrictedAuthDecision({
        email: 'someone@example.com',
        origin: 'https://dev.kortix.com',
      }),
    ).toMatchObject({ restricted: true, allowed: false });
    expect(
      restrictedAuthDecision({
        email: 'someone@example.com',
        origin: 'https://staging.kortix.com',
      }),
    ).toMatchObject({ restricted: true, allowed: false });
  });

  test('allows Kortix team domains on restricted hosts', () => {
    expect(
      restrictedAuthDecision({
        email: 'marko@kortix.ai',
        origin: 'https://staging.kortix.com',
      }).allowed,
    ).toBe(true);
    expect(
      restrictedAuthDecision({
        email: 'marko@kortix.com',
        origin: 'https://dev.kortix.com',
      }).allowed,
    ).toBe(true);
  });

  test('supports exact-email and domain overrides', () => {
    process.env.KORTIX_AUTH_ACCESS_MODE = 'restricted';
    process.env.KORTIX_AUTH_ALLOWED_EMAILS = 'person@example.com';
    process.env.KORTIX_AUTH_ALLOWED_EMAIL_DOMAINS = 'internal.example';

    expect(restrictedAuthDecision({ email: 'person@example.com' }).allowed).toBe(true);
    expect(restrictedAuthDecision({ email: 'teammate@internal.example' }).allowed).toBe(true);
    expect(restrictedAuthDecision({ email: 'other@example.com' }).allowed).toBe(false);
  });

  test('explicit open mode disables the non-prod host gate', () => {
    process.env.KORTIX_AUTH_ACCESS_MODE = 'open';

    expect(
      restrictedAuthDecision({
        email: 'someone@example.com',
        origin: 'https://staging.kortix.com',
      }).allowed,
    ).toBe(true);
  });
});
