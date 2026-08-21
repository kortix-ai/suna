/**
 * Regression: a token with `revoked_at` stamped must NOT authenticate.
 *
 * `validateAccountToken` used to gate on `status = 'active'` alone. Nothing in
 * the database ties `status` and `revoked_at` together — there is no CHECK, no
 * trigger and no partial index on `account_tokens` — so any writer that stamps
 * `revoked_at` without also flipping `status` left a fully live credential.
 *
 * That is not hypothetical. The release-gate sweep revokes its test PATs with a
 * direct `UPDATE account_tokens SET revoked_at = now()`; 186 "Connector Session"
 * tokens kept authenticating afterwards and their sandbox agents kept hammering
 * the staging gateway with dead credentials until it reported `degraded`.
 *
 * These tests run in the hermetic unit lane (`scripts/test.sh default`), so the
 * database is a fake. They assert the SHAPE of the query — which columns the
 * WHERE clause constrains — with a positive control proving the assertion can
 * fail. The end-to-end behaviour against real Postgres plus a real HTTP request
 * is covered by `src/__tests__/integration-revoked-token-auth.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accountTokens } from '@kortix/db';

let capturedWhere: unknown = null;
let rows: Array<Record<string, unknown>> = [];

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (cond: unknown) => {
            capturedWhere = cond;
            return { limit: async () => rows };
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined, catch: () => undefined }),
    }),
  }, auditDb: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (cond: unknown) => {
            capturedWhere = cond;
            return { limit: async () => rows };
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined, catch: () => undefined }),
    }),
  },
}));

const { validateAccountToken } = await import('./account-tokens');
const { generateAccountTokenPair } = await import('../shared/crypto');

/**
 * Every column the condition tree constrains.
 *
 * Recursion stops at a column node on purpose: a drizzle column holds a
 * back-reference to its whole table, so descending into one yields every column
 * of `account_tokens` and the assertion would pass no matter what was filtered.
 */
function filteredColumns(node: unknown, seen = new Set<unknown>(), out: string[] = []): string[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  const candidate = node as { name?: unknown; columnType?: unknown };
  if (typeof candidate.name === 'string' && typeof candidate.columnType === 'string') {
    out.push(candidate.name);
    return out;
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    filteredColumns(value, seen, out);
  }
  return out;
}

beforeEach(() => {
  capturedWhere = null;
  rows = [];
});

describe('validateAccountToken revocation gate', () => {
  test('the lookup constrains revoked_at, not only status', async () => {
    const { secretKey } = generateAccountTokenPair();

    await validateAccountToken(secretKey);

    const columns = filteredColumns(capturedWhere);
    expect(columns).toContain('secret_key_hash');
    expect(columns).toContain('status');
    // The fix. Without it a `revoked_at`-stamped row authenticates cleanly and
    // even emits a normal `auth.login.success` audit event, hiding the bypass.
    expect(columns).toContain('revoked_at');
  });

  test('positive control: the assertion above fails on the pre-fix condition', () => {
    // Proves `filteredColumns` actually discriminates rather than always
    // reporting every column of the table.
    const preFix = and(
      inArray(accountTokens.secretKeyHash, ['h']),
      eq(accountTokens.status, 'active'),
    );
    const fixed = and(
      inArray(accountTokens.secretKeyHash, ['h']),
      eq(accountTokens.status, 'active'),
      isNull(accountTokens.revokedAt),
    );
    expect(filteredColumns(preFix)).toEqual(['secret_key_hash', 'status']);
    expect(filteredColumns(fixed)).toEqual(['secret_key_hash', 'status', 'revoked_at']);
  });

  test('a filtered-out row is reported as revoked, never as valid', async () => {
    const { secretKey } = generateAccountTokenPair();
    rows = [];

    const result = await validateAccountToken(secretKey);

    expect(result.isValid).toBe(false);
    expect(result.error).toBe('PAT not found or revoked');
  });

  test('a live row still authenticates — the gate is not just refusing everything', async () => {
    const { secretKey } = generateAccountTokenPair();
    rows = [
      {
        tokenId: 'tok-1',
        accountId: 'acct-1',
        userId: 'user-1',
        projectId: null,
        sessionId: null,
        status: 'active',
        expiresAt: null,
        lastUsedAt: new Date(),
        createdAt: new Date(),
        agentGrant: null,
        patIdleRevokeDays: null,
      },
    ];

    const result = await validateAccountToken(secretKey);

    expect(result.isValid).toBe(true);
    expect(result.accountId).toBe('acct-1');
    expect(result.userId).toBe('user-1');
  });

  test('a malformed token is refused before any lookup runs', async () => {
    const result = await validateAccountToken('not-a-kortix-pat');

    expect(result.isValid).toBe(false);
    expect(capturedWhere).toBeNull();
  });
});
