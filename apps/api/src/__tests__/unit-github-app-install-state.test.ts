/**
 * Unit tests for the GitHub App install-state token (apps/api/src/projects/
 * github.ts): buildGitHubAppInstallState / verifyGitHubAppInstallStatePayload.
 *
 * These are the state tokens GitHub round-trips through the browser on the
 * App install flow (buildGitHubAppInstallUrl → GitHub → GET /install-callback
 * → verifyGitHubAppInstallStatePayload). They correlate an installation back
 * to the initiating Kortix account and carry a 30-minute TTL.
 *
 * Regression coverage for a real bug the ke2e suite surfaced (GHA-2): a bare
 * GET /install-callback with NO `state` query param used to 500 because
 * `verifyGitHubAppInstallStatePayload` called `.split('.')` on `undefined`.
 * The function now mirrors `verifyManifestStartState`'s null-on-non-string
 * contract; these tests pin that contract so it can't regress.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildGitHubAppInstallState,
  verifyGitHubAppInstallStatePayload,
} from '../projects/github';
// buildGitHubAppInstallState is exported from github.ts for testability (it's
// a pure HMAC-base64url function with no side effects; the only caller is
// buildGitHubAppInstallUrl, which feeds the token into a GitHub URL).

const ORIG_SECRET = process.env.SUPABASE_JWT_SECRET;
beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret';
});
afterEach(() => {
  if (ORIG_SECRET === undefined) delete process.env.SUPABASE_JWT_SECRET;
  else process.env.SUPABASE_JWT_SECRET = ORIG_SECRET;
});

describe('verifyGitHubAppInstallStatePayload — defensive input handling', () => {
  test('returns null for undefined (the bare-callback regression)', () => {
    // This is the exact shape that used to 500: GET /install-callback with no
    // query at all → query.state is undefined → .split('.') crashed.
    expect(verifyGitHubAppInstallStatePayload(undefined)).toBeNull();
  });

  test('returns null for null', () => {
    expect(verifyGitHubAppInstallStatePayload(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(verifyGitHubAppInstallStatePayload('')).toBeNull();
  });

  test('returns null for non-string types', () => {
    // The zod schema is `z.string().optional()`, so a non-string can't reach
    // the handler in practice — but the function's contract is now
    // null-on-non-string regardless, defensive against any future caller.
    expect(verifyGitHubAppInstallStatePayload(123 as unknown as string)).toBeNull();
    expect(verifyGitHubAppInstallStatePayload({} as unknown as string)).toBeNull();
  });
});

describe('verifyGitHubAppInstallStatePayload — malformed/foreign tokens', () => {
  test('rejects a token with the wrong version prefix', () => {
    const good = buildGitHubAppInstallState('acct-1');
    const tampered = `v2${good.slice(2)}`;
    expect(verifyGitHubAppInstallStatePayload(tampered)).toBeNull();
  });

  test('rejects a token with too few parts', () => {
    expect(verifyGitHubAppInstallStatePayload('v1.payload')).toBeNull();
    expect(verifyGitHubAppInstallStatePayload('not-a-token')).toBeNull();
  });

  test('rejects a token with too many parts', () => {
    expect(verifyGitHubAppInstallStatePayload('v1.payload.sig.extra')).toBeNull();
  });

  test('rejects a token whose signature was tampered with', () => {
    const good = buildGitHubAppInstallState('acct-1');
    const parts = good.split('.');
    // Flip the last character of the signature — base64url is forgiving, so
    // mutate until the HMAC differs (a single-char swap almost always does).
    const sig = parts[2]!;
    const tamperedSig = sig.endsWith('A') ? sig.slice(0, -1) + 'B' : sig.slice(0, -1) + 'A';
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    expect(verifyGitHubAppInstallStatePayload(tampered)).toBeNull();
  });

  test('rejects a token whose payload was tampered with (signature no longer matches)', () => {
    const good = buildGitHubAppInstallState('acct-1');
    const parts = good.split('.');
    // Decode, swap the account_id, re-encode — signature is over the ORIGINAL
    // payload, so this must fail.
    const payloadJson = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    ) as { account_id: string; nonce?: string; iat: number };
    payloadJson.account_id = 'attacker-acct';
    const tamperedPayload = Buffer.from(JSON.stringify(payloadJson)).toString('base64url');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    expect(verifyGitHubAppInstallStatePayload(tampered)).toBeNull();
  });
});

describe('verifyGitHubAppInstallStatePayload — TTL + happy path', () => {
  test('accepts a freshly-minted token and returns the accountId', () => {
    const token = buildGitHubAppInstallState('acct-1');
    const verified = verifyGitHubAppInstallStatePayload(token);
    expect(verified?.accountId).toBe('acct-1');
  });

  test('accepts a token just inside the 30-minute TTL', () => {
    const twentyNineMinAgo = Date.now() - 29 * 60 * 1000;
    const token = buildGitHubAppInstallState('acct-1', {}, twentyNineMinAgo);
    const verified = verifyGitHubAppInstallStatePayload(token, Date.now());
    expect(verified?.accountId).toBe('acct-1');
  });

  test('rejects a token past the 30-minute TTL', () => {
    const thirtyOneMinAgo = Date.now() - 31 * 60 * 1000;
    const token = buildGitHubAppInstallState('acct-1', {}, thirtyOneMinAgo);
    expect(verifyGitHubAppInstallStatePayload(token, Date.now())).toBeNull();
  });

  test('rejects a token with an iat too far in the future (clock skew guard)', () => {
    const twoMinInFuture = Date.now() + 2 * 60 * 1000;
    const token = buildGitHubAppInstallState('acct-1', {}, twoMinInFuture);
    expect(verifyGitHubAppInstallStatePayload(token, Date.now())).toBeNull();
  });

  test('round-trips the nonce when one is provided', () => {
    const token = buildGitHubAppInstallState('acct-1', { nonce: 'nonce-abc' });
    const verified = verifyGitHubAppInstallStatePayload(token);
    expect(verified?.accountId).toBe('acct-1');
    expect(verified?.nonce).toBe('nonce-abc');
  });
});
