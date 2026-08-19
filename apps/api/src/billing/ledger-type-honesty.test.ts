import { describe, expect, test } from 'bun:test';
import {
  assertLedgerTypeHonesty,
  assertRpcDebitLedgerType,
  describesAdminCorrection,
  isUsageFamilyLedgerType,
  LedgerTypeMismatchError,
  readDeclaredLedgerType,
  USAGE_FAMILY_LEDGER_TYPES,
} from './ledger-type-honesty';

describe('readDeclaredLedgerType', () => {
  test('reads metadata.ledger_type', () => {
    expect(readDeclaredLedgerType({ ledger_type: 'admin_debit' })).toBe('admin_debit');
  });

  test('trims surrounding whitespace', () => {
    expect(readDeclaredLedgerType({ ledger_type: '  admin_debit  ' })).toBe('admin_debit');
  });

  test.each([
    ['null metadata', null],
    ['undefined metadata', undefined],
    ['array metadata', [{ ledger_type: 'admin_debit' }]],
    ['no ledger_type key', { from_daily: 1 }],
    ['empty string ledger_type', { ledger_type: '' }],
    ['whitespace-only ledger_type', { ledger_type: '   ' }],
    ['non-string ledger_type', { ledger_type: 7 }],
  ])('returns null for %s', (_label, metadata) => {
    expect(readDeclaredLedgerType(metadata)).toBeNull();
  });
});

describe('isUsageFamilyLedgerType', () => {
  test.each(USAGE_FAMILY_LEDGER_TYPES.map((kind) => [kind]))('%s is usage family', (kind) => {
    expect(isUsageFamilyLedgerType(kind)).toBe(true);
  });

  test.each([['admin_debit'], ['admin_credit'], ['refund'], ['tier_grant'], ['forfeiture']])(
    '%s is not usage family',
    (kind) => {
      expect(isUsageFamilyLedgerType(kind)).toBe(false);
    },
  );
});

describe('describesAdminCorrection', () => {
  test.each([
    ['Entitlement reconciliation clawback for 2026-07'],
    ['Manual adjustment after support ticket'],
    ['Admin correction (by admin 0000)'],
    ['CLAWBACK of duplicated grant'],
    ['Stripe chargeback'],
  ])('flags %s', (description) => {
    expect(describesAdminCorrection(description)).toBe(true);
  });

  test.each([
    ['LLM · anthropic/claude-sonnet-4.6'],
    ['Sandbox compute'],
    ['Web search tool call'],
    ['Credit usage'],
    [null],
    [undefined],
  ])('does not flag %s', (description) => {
    expect(describesAdminCorrection(description as string | null | undefined)).toBe(false);
  });
});

describe('assertLedgerTypeHonesty', () => {
  test('accepts a row with no metadata at all', () => {
    expect(() =>
      assertLedgerTypeHonesty({ type: 'tier_grant', description: 'Monthly grant' }),
    ).not.toThrow();
  });

  test('accepts type matching metadata.ledger_type exactly', () => {
    expect(() =>
      assertLedgerTypeHonesty({
        type: 'admin_debit',
        description: 'Entitlement reconciliation clawback',
        metadata: { ledger_type: 'admin_debit' },
      }),
    ).not.toThrow();
  });

  test.each([['llm_debit'], ['compute_debit'], ['token_deduction'], ['token_overage']])(
    'accepts the RPC shape type=usage with granular sub-kind %s',
    (kind) => {
      expect(() =>
        assertLedgerTypeHonesty({
          type: 'usage',
          description: 'LLM · anthropic/claude-sonnet-4.6',
          metadata: { from_daily: 0, from_monthly: 1, from_extra: 0, ledger_type: kind },
        }),
      ).not.toThrow();
    },
  );

  test('rejects the 2026-07-30 shape: type=usage with metadata.ledger_type=admin_debit', () => {
    expect(() =>
      assertLedgerTypeHonesty({
        type: 'usage',
        description: 'Entitlement clawback',
        metadata: { ledger_type: 'admin_debit' },
      }),
    ).toThrow(LedgerTypeMismatchError);
  });

  test('the rejection names both sides and the honest type to write', () => {
    try {
      assertLedgerTypeHonesty({
        type: 'usage',
        description: 'x',
        metadata: { ledger_type: 'admin_debit' },
      });
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerTypeMismatchError);
      const mismatch = err as LedgerTypeMismatchError;
      expect(mismatch.rowType).toBe('usage');
      expect(mismatch.declaredLedgerType).toBe('admin_debit');
      expect(mismatch.statusCode).toBe(500);
      expect(mismatch.message).toContain("type='admin_debit'");
    }
  });

  test('rejects a non-usage type carrying a contradicting non-usage sub-kind', () => {
    expect(() =>
      assertLedgerTypeHonesty({
        type: 'tier_grant',
        description: 'Grant',
        metadata: { ledger_type: 'refund' },
      }),
    ).toThrow(LedgerTypeMismatchError);
  });

  test('rejects a usage-typed row whose description reads as a reconciliation', () => {
    expect(() =>
      assertLedgerTypeHonesty({
        type: 'usage',
        description: 'Entitlement reconciliation clawback for account',
      }),
    ).toThrow(/operator correction/);
  });

  test('allows the same description once the type is honest', () => {
    expect(() =>
      assertLedgerTypeHonesty({
        type: 'admin_debit',
        description: 'Entitlement reconciliation clawback for account',
      }),
    ).not.toThrow();
  });

  test('a usage row with a machine-generated description is untouched', () => {
    expect(() =>
      assertLedgerTypeHonesty({
        type: 'usage',
        description: 'LLM · anthropic/claude-sonnet-4.6',
        metadata: { ledger_type: 'llm_debit' },
      }),
    ).not.toThrow();
  });
});

describe('assertRpcDebitLedgerType', () => {
  test.each(USAGE_FAMILY_LEDGER_TYPES.map((kind) => [kind]))('accepts %s', (kind) => {
    expect(() => assertRpcDebitLedgerType(kind)).not.toThrow();
  });

  test.each([['admin_debit'], ['refund'], ['adjustment']])(
    'rejects %s because the RPC would stamp type=usage on it',
    (kind) => {
      expect(() => assertRpcDebitLedgerType(kind)).toThrow(LedgerTypeMismatchError);
    },
  );

  test('the rejection explains the row shape it prevents', () => {
    expect(() => assertRpcDebitLedgerType('admin_debit')).toThrow(
      /atomic_use_credits writes type='usage' unconditionally/,
    );
  });
});
