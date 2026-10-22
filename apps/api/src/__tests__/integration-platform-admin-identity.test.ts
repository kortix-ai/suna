/**
 * Integration test (real local DB): the self-host operator allowlist
 * (`KORTIX_PLATFORM_ADMIN_EMAILS`) makes platform admin, and the self-host
 * operator, only a password / email-code / social identity, never a SAML one.
 *
 * Supabase creates a separate SSO auth user for every address a SAML IdP
 * asserts, without comparing it with the IdP's domains, and any account admin
 * can register an IdP. An allowlist match on that user made a stranger
 * platform admin (KRTX-1715).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgClient } from './helpers/pg-client';

const { getPlatformRole, isSelfHostOperator } = await import('../shared/platform-roles');

const superuser = new PgClient({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
const OPERATOR_EMAIL = `operator-${crypto.randomUUID()}@example.test`;
const COLLEAGUE_EMAIL = `colleague-${crypto.randomUUID()}@example.test`;
const ORIGINAL_ALLOWLIST = process.env.KORTIX_PLATFORM_ADMIN_EMAILS;

/** An auth user as Supabase writes it for each sign-in method. */
async function authUser(email: string, kind: 'password' | 'saml' | 'saml-metadata-only') {
  const id = crypto.randomUUID();
  const idp = crypto.randomUUID();
  const appMeta =
    kind === 'password'
      ? { provider: 'email', providers: ['email'] }
      : { provider: `sso:${idp}`, providers: [`sso:${idp}`] };
  await superuser.query(
    `insert into auth.users (id, email, is_sso_user, raw_app_meta_data) values ($1, $2, $3, $4::jsonb)`,
    [id, email, kind === 'saml', JSON.stringify(appMeta)],
  );
  return id;
}

beforeAll(async () => {
  await superuser.connect();
});
afterAll(async () => {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.KORTIX_PLATFORM_ADMIN_EMAILS;
  else process.env.KORTIX_PLATFORM_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  await superuser.end();
});

describe('the operator allowlist', () => {
  test('a password identity with an allowlisted email is platform admin and the operator', async () => {
    const operator = await authUser(OPERATOR_EMAIL, 'password');
    process.env.KORTIX_PLATFORM_ADMIN_EMAILS = OPERATOR_EMAIL;

    expect(await getPlatformRole(operator)).toBe('admin');
    expect(await isSelfHostOperator(operator)).toBe(true);
  });

  test('a SAML identity asserting the same email is neither', async () => {
    // The stranger's own IdP asserts the operator's address; Supabase creates a
    // second, SSO auth user for it.
    const stranger = await authUser(OPERATOR_EMAIL, 'saml');
    process.env.KORTIX_PLATFORM_ADMIN_EMAILS = OPERATOR_EMAIL;

    expect(await getPlatformRole(stranger)).toBe('user');
    expect(await isSelfHostOperator(stranger)).toBe(false);
  });

  test('an identity whose app metadata names an IdP is never matched either', async () => {
    const viaIdp = await authUser(COLLEAGUE_EMAIL, 'saml-metadata-only');
    process.env.KORTIX_PLATFORM_ADMIN_EMAILS = COLLEAGUE_EMAIL;

    expect(await getPlatformRole(viaIdp)).toBe('user');
    expect(await isSelfHostOperator(viaIdp)).toBe(false);
  });

  test('without an allowlist nobody is admin through it', async () => {
    const operator = await authUser(`unlisted-${crypto.randomUUID()}@example.test`, 'password');
    delete process.env.KORTIX_PLATFORM_ADMIN_EMAILS;

    expect(await getPlatformRole(operator)).toBe('user');
    expect(await isSelfHostOperator(operator)).toBe(false);
  });
});
