import { describe, expect, mock, test } from 'bun:test';

// validateSecretKey hashes with the platform pepper before it probes, so the
// pepper must exist before the module under test (and its config) loads.
process.env.API_KEY_SECRET = 'unit-api-key-shape-guard-secret';

let selectCalls = 0;

mock.module('../lib/db', () => ({
  db: {
    select: () => {
      selectCalls += 1;
      return {
        from: () => ({
          where: () => ({
            limit: async () => [] as unknown[],
          }),
        }),
      };
    },
    update: () => ({ set: () => ({ where: async () => [] }) }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    delete: () => ({ where: async () => [] }),
  },
}));

const { validateSecretKey } = await import('../services/repositories/api-keys');

function captureWarn(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  return { warns, restore: () => { console.warn = realWarn; } };
}

/**
 * KRTX-1414: a credential minted into one of the platform's other tables (a
 * session/CLI PAT, a service account, a gateway key, a tunnel token, an OAuth
 * token) can never match `kortix_api_keys`. Feeding it to `validateSecretKey`
 * used to cost one doomed indexed probe plus a warn that lied — "Token not
 * found in DB" — for a token that was never an API key. Prod 2026-10-03: one
 * client presenting its session PAT to `/v1/router/*` wrote 71 of those warns
 * in a minute. The validator must refuse such a token by shape: precise
 * error, no probe, no warn.
 */
describe('validateSecretKey refuses credentials of other tables by shape', () => {
  for (const [token, shape] of [
    ['kortix_pat_abcdefghijklmnopqrstuvwxyz12', 'personal access token'],
    ['kortix_sa_abcdefghijklmnopqrstuvwxyz12', 'service-account token'],
    ['kortix_gw_abcdefghijklmnopqrstuvwxyz12', 'gateway key'],
    ['kortix_tnl_abcdefghijklmnopqrstuvwxyz12', 'tunnel token'],
    ['kortix_oat_abcdefghijklmnopqrstuvwxyz12', 'OAuth access token'],
    ['kortix_ort_abcdefghijklmnopqrstuvwxyz12', 'OAuth refresh token'],
  ] as const) {
    test(`${shape} (${token.slice(0, 11)}…) is refused without a DB probe or a warn`, async () => {
      selectCalls = 0;
      const { warns, restore } = captureWarn();
      try {
        const result = await validateSecretKey(token);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain(shape);
        expect(result.error).toContain('not an API key');
        expect(selectCalls).toBe(0);
        expect(warns).toEqual([]);
      } finally {
        restore();
      }
    });
  }

  test('the bare prefix of a foreign shape is refused the same way', async () => {
    selectCalls = 0;
    const result = await validateSecretKey('kortix_pat_');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('personal access token');
    expect(selectCalls).toBe(0);
  });
});

describe('validateSecretKey still probes the shapes its table holds', () => {
  test('an unknown kortix_ API key probes once and warns not-found', async () => {
    selectCalls = 0;
    const { warns, restore } = captureWarn();
    try {
      const result = await validateSecretKey('kortix_abcdefghijklmnopqrstuvwxyz');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('API key not found or invalid');
      expect(selectCalls).toBe(1);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('[validateSecretKey]');
    } finally {
      restore();
    }
  });

  test('an unknown kortix_sb_ sandbox key probes once too', async () => {
    selectCalls = 0;
    const result = await validateSecretKey('kortix_sb_abcdefghijklmnopqrstuvwxyz');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('API key not found or invalid');
    expect(selectCalls).toBe(1);
  });
});
