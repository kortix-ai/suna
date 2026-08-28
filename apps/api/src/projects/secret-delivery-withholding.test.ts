import { describe, expect, test } from 'bun:test';

import {
  materializeSecretDelivery,
  type ResolvedProjectSecret,
  withholdUndeliverable,
} from './secrets';

const row = (
  identifier: string,
  key: string,
  extra: Partial<ResolvedProjectSecret> = {},
): ResolvedProjectSecret => ({
  secretId: `secret-${identifier}`,
  identifier,
  key,
  value: `value-of-${identifier}`,
  ...extra,
});

/** The env map as `resolveGrantedSecretEnv` would have produced it. */
const envFor = (rows: ResolvedProjectSecret[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.key, r.value]));

describe('withholdUndeliverable', () => {
  test('a project with no strategies set is byte-identical to before', () => {
    // The back-compat guarantee. Every existing row has strategy `runtime` (the
    // column default) or, for a row read before the column existed, undefined —
    // and neither may remove anything.
    const rows = [
      row('gmail', 'GMAIL_TOKEN'),
      row('stripe', 'STRIPE_KEY', { strategy: 'runtime' }),
    ];
    const env = envFor(rows);
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env).toEqual({
      GMAIL_TOKEN: 'value-of-gmail',
      STRIPE_KEY: 'value-of-stripe',
    });
  });

  test('DENIED is withheld — the whole point', () => {
    const rows = [row('gmail', 'GMAIL_TOKEN'), row('stripe', 'STRIPE_KEY', { strategy: 'denied' })];
    const env = envFor(rows);
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env).toEqual({ GMAIL_TOKEN: 'value-of-gmail' });
    expect(env.STRIPE_KEY).toBeUndefined();
  });

  test('denied is withheld even with no session — nothing can resurrect it', () => {
    const rows = [row('stripe', 'STRIPE_KEY', { strategy: 'denied' })];
    const env = envFor(rows);
    withholdUndeliverable(rows, env, null);
    expect(env).toEqual({});
  });

  test('a BROKER row is withheld when there is no session to mint a handle against', () => {
    // Fail closed. Falling back to plaintext here would defeat the entire
    // mechanism at exactly the moment it is hardest to notice.
    const rows = [row('anthropic', 'ANTHROPIC_API_KEY', { strategy: 'broker' })];
    const env = envFor(rows);
    withholdUndeliverable(rows, env, null);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test.each(['broker', 'egress'] as const)(
    '%s is withheld with a session until its delivery adapter exists',
    (strategy) => {
      const rows = [row('provider', 'PROVIDER_KEY', { strategy })];
      const env = envFor(rows);

      withholdUndeliverable(rows, env, 'sess-1');

      expect(env.PROVIDER_KEY).toBeUndefined();
    },
  );

  test('THE SHARED KEY: a live runtime row keeps the KEY its denied sibling shares', () => {
    // Two identifiers may resolve to ONE env KEY — deliberate, so an agent can be
    // granted one specific value among several candidates for the same variable.
    // Dropping the KEY because one of them is denied would break a session that
    // is legitimately using the other.
    const rows = [
      row('gmaps-primary', 'GMAPS_KEY', { strategy: 'denied' }),
      row('gmaps-backup', 'GMAPS_KEY', { strategy: 'runtime' }),
    ];
    const env = { GMAPS_KEY: 'value-of-gmaps-backup' };
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env.GMAPS_KEY).toBe('value-of-gmaps-backup');
  });

  test('...but a KEY every identifier denies IS dropped', () => {
    const rows = [
      row('gmaps-primary', 'GMAPS_KEY', { strategy: 'denied' }),
      row('gmaps-backup', 'GMAPS_KEY', { strategy: 'denied' }),
    ];
    const env = { GMAPS_KEY: 'whichever-won' };
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env.GMAPS_KEY).toBeUndefined();
  });

  test('a KEY absent from env is not resurrected by a deliverable row', () => {
    // The agent grant may already have excluded it upstream. This function only
    // ever narrows; it must never add.
    const rows = [row('gmail', 'GMAIL_TOKEN', { strategy: 'runtime' })];
    const env: Record<string, string> = {};
    withholdUndeliverable(rows, env, 'sess-1');
    expect(env).toEqual({});
  });

  test('an empty row set leaves env untouched', () => {
    const env = { SOMETHING: 'x' };
    withholdUndeliverable([], env, 'sess-1');
    expect(env).toEqual({ SOMETHING: 'x' });
  });
});

describe('only GRANTED rows may vote on a shared key (Strix HIGH)', () => {
  test('an UNGRANTED runtime sibling cannot keep a denied secret alive', () => {
    // The hole: `env` is produced by resolveGrantedSecretEnv, which drops rows
    // outside the agent grant. Feeding the FULL row set to the withholding pass
    // let one of those dropped rows mark a shared KEY deliverable — so the KEY
    // survived holding the DENIED sibling's plaintext, which is the one value
    // that must never reach the box.
    //
    // The caller now passes only the granted rows. This test models what the
    // caller is required to hand over.
    const denied = row('gmaps-primary', 'GMAPS_KEY', { strategy: 'denied' });
    const ungrantedSibling = row('gmaps-backup', 'GMAPS_KEY', {
      strategy: 'runtime',
    });
    const env = { GMAPS_KEY: denied.value };

    // Only `denied` was granted, so only it is passed in.
    withholdUndeliverable([denied], env, 'sess-1');
    expect(env.GMAPS_KEY).toBeUndefined();

    // Sanity: had the ungranted sibling been included, the key would survive —
    // which is precisely the bug.
    const envIfBuggy = { GMAPS_KEY: denied.value };
    withholdUndeliverable([denied, ungrantedSibling], envIfBuggy, 'sess-1');
    expect(envIfBuggy.GMAPS_KEY).toBe(denied.value);
  });
});

describe('materializeSecretDelivery', () => {
  test('withholds model credentials even when a legacy row says runtime', async () => {
    // A LEGACY row: written before `consumer` existed, so it carries no stamp.
    // The fixture used to say `consumer: 'sandbox'`, which today is what the
    // secrets UI stamps on a HUMAN's own secret — conflating "legacy" with
    // "explicitly a sandbox secret". That conflation is what withheld a
    // project's own GITHUB_TOKEN (models.dev maps `github-copilot` to that
    // name). An unstamped row still strips; see `gatewayStripsRow`.
    const provider = row('openai', 'OPENAI_API_KEY', {
      strategy: 'runtime',
    });
    const env = envFor([provider]);

    await materializeSecretDelivery([provider], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: 'all',
      mintHandleFor: async () => {
        throw new Error('must not mint');
      },
    });

    expect(env).toEqual({});
  });

  test('replaces a managed broker value with a session handle', async () => {
    const brokered = row('provider', 'PROVIDER_KEY', {
      strategy: 'broker',
      egressPolicy: {
        backend: 'kortix_fetch',
        inject: { kind: 'header', name: 'authorization' },
        rules: [
          {
            host: 'api.example.com',
            inject: { kind: 'header', name: 'authorization' },
          },
        ],
      },
    });
    const env = envFor([brokered]);
    const minted: string[] = [];

    await materializeSecretDelivery([brokered], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['provider'],
      mintHandleFor: async (selected) => {
        minted.push(selected.secretId);
        return 'kortix-handle';
      },
    });

    expect(env).toEqual({ PROVIDER_KEY: 'kortix-handle' });
    expect(JSON.stringify(env)).not.toContain('value-of-provider');
    expect(minted).toEqual(['secret-provider']);
  });

  test('an egress-enforced secret delivers its HANDLE, never its value', async () => {
    // docs/specs/2026-08-19-secrets-exposure-usage-model.md §5. This row used
    // to mint the handle and export nothing at all, which left the agent with
    // an unset variable and no way to spend the secret it had been granted.
    // The handle is what makes the mechanism transparent: an ordinary HTTP
    // client sends it and the relay substitutes the value server-side.
    const boundary = row('gh', 'GITHUB_TEST', {
      strategy: 'egress',
      consumer: 'network',
      egressPolicy: {
        inject: { kind: 'header', name: 'authorization' },
        rules: [{ host: 'api.github.com' }],
      },
    });
    const env = envFor([boundary]);
    const minted: string[] = [];

    await materializeSecretDelivery([boundary], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['gh'],
      mintHandleFor: async (selected) => {
        minted.push(selected.secretId);
        return 'kortix-handle';
      },
    });

    // The row was minted — the relay looks the secret up by it...
    expect(minted).toEqual(['secret-gh']);
    // ...the KEY carries the handle, and the value never enters the box.
    expect(env).toEqual({ GITHUB_TEST: 'kortix-handle' });
    expect(JSON.stringify(env)).not.toContain('value-of-gh');
  });

  test('an egress-enforced row with no policy still delivers nothing', async () => {
    // There is nothing to freeze into the handle's snapshot, so the row is
    // dropped instead of minted — a mint that throws here would take the whole
    // env snapshot, and the session boot behind it, down with it.
    const boundary = row('gh', 'GITHUB_TEST', { strategy: 'egress', consumer: 'network' });
    const env = envFor([boundary]);

    await materializeSecretDelivery([boundary], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['gh'],
      mintHandleFor: async () => {
        throw new Error('mintHandleFor must not be called without a policy');
      },
    });

    expect(env).toEqual({});
  });

  test('mints no handle for a boundary secret the agent is not granted', async () => {
    // No grant means no delivery at all — minting a row would create a
    // spendable reference for a secret this session may not use.
    const boundary = row('gh', 'GITHUB_TEST', {
      strategy: 'egress',
      consumer: 'network',
      egressPolicy: {
        inject: { kind: 'header', name: 'authorization' },
        rules: [{ host: 'api.github.com' }],
      },
    });
    const env = envFor([boundary]);
    const minted: string[] = [];

    await materializeSecretDelivery([boundary], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['something-else'],
      mintHandleFor: async (selected) => {
        minted.push(selected.secretId);
        return 'kortix-handle';
      },
    });

    expect(minted).toEqual([]);
    expect(env).toEqual({});
  });

  test.each([undefined, 'all'] as const)(
    'withholds a broker value from an unscoped %s grant',
    async (grantEnv) => {
      const brokered = row('provider', 'PROVIDER_KEY', {
        strategy: 'broker',
        egressPolicy: {
          backend: 'kortix_fetch',
          inject: { kind: 'header', name: 'authorization' },
          rules: [{ host: 'api.example.com' }],
        },
      });
      const env = envFor([brokered]);
      let mintCount = 0;

      await materializeSecretDelivery([brokered], env, {
        sessionId: 'session-1',
        llmGatewayEnabled: true,
        grantEnv,
        mintHandleFor: async () => {
          mintCount += 1;
          return 'must-not-mint';
        },
      });

      expect(env).toEqual({});
      expect(mintCount).toBe(0);
    },
  );

  test('withholds broker delivery when no managed policy exists', async () => {
    const brokered = row('provider', 'PROVIDER_KEY', {
      strategy: 'broker',
    });
    const env = envFor([brokered]);

    await materializeSecretDelivery([brokered], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['provider'],
      mintHandleFor: async () => 'must-not-mint',
    });

    expect(env).toEqual({});
  });

  test('withholds an LLM gateway secret without minting a sandbox handle', async () => {
    const gateway = row('provider', 'PROVIDER_KEY', {
      strategy: 'broker',
      consumer: 'llm_gateway',
    });
    const env = envFor([gateway]);
    let mintCount = 0;

    await materializeSecretDelivery([gateway], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['provider'],
      mintHandleFor: async () => {
        mintCount += 1;
        return 'must-not-mint';
      },
    });

    expect(env).toEqual({});
    expect(mintCount).toBe(0);
  });

  test('fails closed when a runtime strategy targets a server consumer', async () => {
    const gateway = row('provider', 'PROVIDER_KEY', {
      strategy: 'runtime',
      consumer: 'llm_gateway',
    });
    const env = envFor([gateway]);

    await materializeSecretDelivery([gateway], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['provider'],
      mintHandleFor: async () => 'must-not-mint',
    });

    expect(env).toEqual({});
  });

  test.each([
    ['runtime', 'value-of-provider'],
    ['egress', undefined],
    ['denied', undefined],
  ] as const)('materializes %s without a broker mint', async (strategy, expected) => {
    const selected = row('provider', 'PROVIDER_KEY', { strategy });
    const env = envFor([selected]);
    let mintCount = 0;

    await materializeSecretDelivery([selected], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['provider'],
      mintHandleFor: async () => {
        mintCount += 1;
        return 'must-not-mint';
      },
    });

    if (expected === undefined) expect(env.PROVIDER_KEY).toBeUndefined();
    else expect(env.PROVIDER_KEY).toBe(expected);
    expect(mintCount).toBe(0);
  });

  // ── Native mode (project `llm_gateway` flag OFF) ─────────────────────────
  // The same stored rows ARE the box's credentials: gateway-managed names stay,
  // and `consumer: 'llm_gateway'` rows deliver plaintext so OpenCode's native
  // provider management auto-connects from the process env.

  test('native mode delivers a model credential runtime row as plaintext', async () => {
    const provider = row('openai', 'OPENAI_API_KEY', {
      strategy: 'runtime',
      consumer: 'sandbox',
    });
    const env = envFor([provider]);

    await materializeSecretDelivery([provider], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: false,
      grantEnv: 'all',
      mintHandleFor: async () => {
        throw new Error('must not mint');
      },
    });

    expect(env).toEqual({ OPENAI_API_KEY: 'value-of-openai' });
  });

  test('native mode delivers a broker/llm_gateway provider key as plaintext, no mint', async () => {
    const gateway = row('provider', 'PROVIDER_KEY', {
      strategy: 'broker',
      consumer: 'llm_gateway',
    });
    const env = envFor([gateway]);
    let mintCount = 0;

    await materializeSecretDelivery([gateway], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: false,
      grantEnv: ['provider'],
      mintHandleFor: async () => {
        mintCount += 1;
        return 'must-not-mint';
      },
    });

    expect(env).toEqual({ PROVIDER_KEY: 'value-of-provider' });
    expect(mintCount).toBe(0);
  });

  test('native mode still brokers an http_broker secret by handle', async () => {
    const brokered = row('provider', 'PROVIDER_KEY', {
      strategy: 'broker',
      egressPolicy: {
        backend: 'kortix_fetch',
        inject: { kind: 'header', name: 'authorization' },
        rules: [
          {
            host: 'api.example.com',
            inject: { kind: 'header', name: 'authorization' },
          },
        ],
      },
    });
    const env = envFor([brokered]);

    await materializeSecretDelivery([brokered], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: false,
      grantEnv: ['provider'],
      mintHandleFor: async () => 'kortix-handle',
    });

    expect(env).toEqual({ PROVIDER_KEY: 'kortix-handle' });
  });

  test('does not add a selected key that the grant resolver excluded', async () => {
    const selected = row('provider', 'PROVIDER_KEY', { strategy: 'runtime' });
    const env: Record<string, string> = {};

    await materializeSecretDelivery([selected], env, {
      sessionId: 'session-1',
      llmGatewayEnabled: true,
      grantEnv: ['different-provider'],
      mintHandleFor: async () => 'must-not-mint',
    });

    expect(env).toEqual({});
  });
});
