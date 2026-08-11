import { describe, expect, test } from 'bun:test';

import type { ServiceAccount } from '@/lib/iam-client';
import type { AccountToken, KortixProject } from '@kortix/sdk';
import {
  RUNTIME_TOKEN_NAME_PREFIX,
  buildApiKeyRows,
  countApiKeysByStatus,
  filterApiKeyRows,
  isRuntimeMintedKey,
  shortKeyHint,
} from './api-key-rows';

/** Fixed "now" for every expiry assertion — real clocks make flaky tests. */
const NOW = Date.parse('2026-08-12T00:00:00.000Z');
const YESTERDAY = '2026-08-11T00:00:00.000Z';
const NEXT_YEAR = '2027-08-12T00:00:00.000Z';

/**
 * Real logic, real assertions — this module is pure precisely so the parts of
 * the API keys tab that can be wrong (what is hidden, what order rows come in,
 * what a row says) are provable without a DOM.
 */

function token(over: Partial<AccountToken> = {}): AccountToken {
  return {
    token_id: 'tok_1',
    name: 'ci-deploy',
    project_id: null,
    // Real shape: `pk_` + 32 random characters (`shared/crypto.ts`).
    public_key: 'pk_abcdefghijklmnopqrstuvwxyz012345',
    status: 'active',
    expires_at: null,
    last_used_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    revoked_at: null,
    ...over,
  };
}

function serviceAccount(over: Partial<ServiceAccount> = {}): ServiceAccount {
  return {
    service_account_id: 'sa_1',
    name: 'github-actions',
    description: null,
    // Real shape: `kortix_sa_` + 8 characters + `…`, already trimmed server-side.
    public_prefix: 'kortix_sa_abcd1234…',
    status: 'active',
    last_used_at: null,
    expires_at: null,
    created_at: '2026-08-02T00:00:00.000Z',
    disabled_at: null,
    ...over,
  };
}

function project(over: Partial<KortixProject> = {}): KortixProject {
  return { project_id: 'proj_1', name: 'Checkout API', ...over } as KortixProject;
}

describe('isRuntimeMintedKey', () => {
  test('hides the per-session token the sandbox mints for itself', () => {
    expect(
      isRuntimeMintedKey({ name: `${RUNTIME_TOKEN_NAME_PREFIX}a1b2c3d4`, project_id: 'proj_1' }),
    ).toBe(true);
  });

  test('keeps a human key that happens to be scoped to one project', () => {
    expect(isRuntimeMintedKey({ name: 'deploy bot', project_id: 'proj_1' })).toBe(false);
  });

  test('keeps an account-wide key even if someone names it after a session', () => {
    // Both halves are required: without the project binding this is a key a
    // person made and must be able to revoke.
    expect(
      isRuntimeMintedKey({ name: `${RUNTIME_TOKEN_NAME_PREFIX}a1b2c3d4`, project_id: null }),
    ).toBe(false);
  });
});

describe('shortKeyHint', () => {
  test("trims a PAT's 35-character public key and marks the cut", () => {
    expect(shortKeyHint('pk_abcdefghijklmnopqrstuvwxyz012345')).toBe('pk_abcdefghijklmnopq…');
  });

  test("leaves a service account's already-trimmed prefix whole", () => {
    expect(shortKeyHint('kortix_sa_abcd1234…')).toBe('kortix_sa_abcd1234…');
  });

  test('never doubles the ellipsis when the cut lands on one', () => {
    expect(shortKeyHint('kortix_sa_abcd1234…', 19)).toBe('kortix_sa_abcd1234…');
    expect(shortKeyHint('kortix_sa_abcdefgh…', 10)).toBe('kortix_sa_…');
  });
});

describe('buildApiKeyRows', () => {
  test('merges both sources into one list', () => {
    const rows = buildApiKeyRows({
      tokens: [token()],
      serviceAccounts: [serviceAccount()],
    });
    expect(rows.map((r) => r.kind)).toEqual(['automation', 'personal']);
    expect(rows.map((r) => r.name)).toEqual(['github-actions', 'ci-deploy']);
  });

  test('drops runtime-minted session tokens', () => {
    const rows = buildApiKeyRows({
      tokens: [
        token(),
        token({
          token_id: 'tok_session',
          name: `${RUNTIME_TOKEN_NAME_PREFIX}a1b2c3d4`,
          project_id: 'proj_1',
        }),
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['tok_1']);
  });

  test('working keys sort above expired, expired above revoked, newest first inside each', () => {
    const rows = buildApiKeyRows({
      now: NOW,
      tokens: [
        token({ token_id: 'old-active', created_at: '2026-01-01T00:00:00.000Z' }),
        token({
          token_id: 'revoked-new',
          status: 'revoked',
          created_at: '2026-08-09T00:00:00.000Z',
        }),
        token({ token_id: 'new-active', created_at: '2026-08-10T00:00:00.000Z' }),
        token({
          token_id: 'expired',
          expires_at: YESTERDAY,
          created_at: '2026-08-11T00:00:00.000Z',
        }),
      ],
      serviceAccounts: [
        serviceAccount({
          service_account_id: 'disabled-sa',
          status: 'disabled',
          created_at: '2026-08-01T00:00:00.000Z',
        }),
      ],
    });
    expect(rows.map((r) => r.id)).toEqual([
      'new-active',
      'old-active',
      'expired',
      'revoked-new',
      'disabled-sa',
    ]);
  });

  /**
   * Neither backend rewrites `status` when a key's `expires_at` passes — the
   * check happens at authentication time. Without this derivation the table
   * would show a dead key as "Active", which is the one thing a key list must
   * never do.
   */
  test('a past expiry reads as expired even though the backend still says active', () => {
    const [row] = buildApiKeyRows({ now: NOW, tokens: [token({ expires_at: YESTERDAY })] });
    expect(row?.status).toBe('expired');
  });

  test('a future expiry is still active', () => {
    const [row] = buildApiKeyRows({ now: NOW, tokens: [token({ expires_at: NEXT_YEAR })] });
    expect(row?.status).toBe('active');
    expect(row?.expiresAt).toBe(NEXT_YEAR);
  });

  test('revoked beats expired — a revoked key is not described as merely lapsed', () => {
    const [row] = buildApiKeyRows({
      now: NOW,
      tokens: [token({ status: 'revoked', expires_at: YESTERDAY })],
    });
    expect(row?.status).toBe('revoked');
  });

  test('an unparseable expiry is not treated as expiry', () => {
    const [row] = buildApiKeyRows({ now: NOW, tokens: [token({ expires_at: 'not-a-date' })] });
    expect(row?.status).toBe('active');
  });

  test('a service account past its expiry reads as expired too', () => {
    const [row] = buildApiKeyRows({
      now: NOW,
      serviceAccounts: [serviceAccount({ expires_at: YESTERDAY })],
    });
    expect(row?.status).toBe('expired');
  });

  test('a project-scoped key names its project', () => {
    const [row] = buildApiKeyRows({
      tokens: [token({ project_id: 'proj_1' })],
      projects: [project()],
    });
    expect(row?.scopeLabel).toBe('Checkout API');
  });

  test('a project-scoped key with no matching project falls back to a short id', () => {
    const [row] = buildApiKeyRows({
      tokens: [token({ project_id: '0a1b2c3d-4e5f-6789-abcd-ef0123456789' })],
      projects: [project()],
    });
    expect(row?.scopeLabel).toBe('0a1b2c3d…');
  });

  test('an account-wide key has no scope label', () => {
    const [row] = buildApiKeyRows({ tokens: [token()] });
    expect(row?.scopeLabel).toBeNull();
  });

  test('automation keys are always workspace-wide — scope belongs to their policies', () => {
    const [row] = buildApiKeyRows({ serviceAccounts: [serviceAccount()] });
    expect(row?.scopeLabel).toBeNull();
    expect(row?.hint).toBe('kortix_sa_abcd1234…');
  });

  test('a disabled service account is revoked', () => {
    const [row] = buildApiKeyRows({ serviceAccounts: [serviceAccount({ status: 'disabled' })] });
    expect(row?.status).toBe('revoked');
  });

  test('no keys at all is an empty list, not a throw', () => {
    expect(buildApiKeyRows({})).toEqual([]);
  });
});

describe('filterApiKeyRows', () => {
  const rows = buildApiKeyRows({
    now: NOW,
    tokens: [
      token({ token_id: 'laptop', name: 'My laptop' }),
      token({ token_id: 'lapsed', name: 'Old deploy key', expires_at: YESTERDAY }),
      token({ token_id: 'dead', name: 'Leaked key', status: 'revoked' }),
      token({ token_id: 'scoped', name: 'Checkout deploy', project_id: 'proj_1' }),
    ],
    serviceAccounts: [serviceAccount({ service_account_id: 'ci', name: 'GitHub Actions' })],
    projects: [project()],
  });

  test('no filter shows everything', () => {
    expect(filterApiKeyRows(rows)).toHaveLength(5);
    expect(filterApiKeyRows(rows, {})).toHaveLength(5);
  });

  test('filters by status', () => {
    // Order is `buildApiKeyRows`'s, preserved: the service account is a day
    // newer than the tokens, and filtering never re-sorts.
    expect(filterApiKeyRows(rows, { status: 'active' }).map((r) => r.id)).toEqual([
      'ci',
      'laptop',
      'scoped',
    ]);
    expect(filterApiKeyRows(rows, { status: 'expired' }).map((r) => r.id)).toEqual(['lapsed']);
    expect(filterApiKeyRows(rows, { status: 'revoked' }).map((r) => r.id)).toEqual(['dead']);
  });

  test('filters by type', () => {
    expect(filterApiKeyRows(rows, { kind: 'automation' }).map((r) => r.id)).toEqual(['ci']);
    expect(filterApiKeyRows(rows, { kind: 'personal' })).toHaveLength(4);
  });

  test('status and type compose', () => {
    expect(filterApiKeyRows(rows, { kind: 'automation', status: 'revoked' })).toEqual([]);
  });

  test('search matches the name, case-insensitively', () => {
    expect(filterApiKeyRows(rows, { search: 'github' }).map((r) => r.id)).toEqual(['ci']);
    expect(filterApiKeyRows(rows, { search: 'DEPLOY' }).map((r) => r.id)).toEqual([
      'scoped',
      'lapsed',
    ]);
  });

  /** Search covers exactly the three fields a row shows — nothing hidden. */
  test('search matches the key hint and the scope label too', () => {
    expect(filterApiKeyRows(rows, { search: 'kortix_sa_' }).map((r) => r.id)).toEqual(['ci']);
    expect(filterApiKeyRows(rows, { search: 'Checkout API' }).map((r) => r.id)).toEqual(['scoped']);
  });

  test('whitespace-only search is no search', () => {
    expect(filterApiKeyRows(rows, { search: '   ' })).toHaveLength(5);
  });

  test('a search with no match returns nothing, rather than falling back to everything', () => {
    expect(filterApiKeyRows(rows, { search: 'zzzz' })).toEqual([]);
  });
});

describe('countApiKeysByStatus', () => {
  test('counts each state and the total', () => {
    const rows = buildApiKeyRows({
      now: NOW,
      tokens: [
        token({ token_id: 'a' }),
        token({ token_id: 'b' }),
        token({ token_id: 'c', expires_at: YESTERDAY }),
        token({ token_id: 'd', status: 'revoked' }),
      ],
    });
    expect(countApiKeysByStatus(rows)).toEqual({ all: 4, active: 2, expired: 1, revoked: 1 });
  });

  test('an empty list counts zeroes, so the filter bar still renders numbers', () => {
    expect(countApiKeysByStatus([])).toEqual({ all: 0, active: 0, expired: 0, revoked: 0 });
  });
});
