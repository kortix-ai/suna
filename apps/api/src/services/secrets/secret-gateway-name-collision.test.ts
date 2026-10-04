import { describe, expect, test } from 'bun:test';
import {
  gatewayStripsRow,
  materializeSecretDelivery,
  type ResolvedProjectSecret,
} from './secrets';

// Regression: a project's own `GITHUB_TOKEN` never reached its sandbox.
//
// models.dev ships a `github-copilot` provider whose credential env is
// ["GITHUB_TOKEN"], so `providerCredentialEnv()` contains that name and
// `isGatewayManagedEnv('GITHUB_TOKEN')` is true. `materializeSecretDelivery`
// then deleted the user's secret from the env by NAME COLLISION alone, while
// `buildSecretCapabilities` — built from the pre-delivery `selected` list —
// kept advertising it. The box was told it held a secret it did not hold.
//
// Observed in prod 2026-08-27: the agent's capability doc listed GITHUB_TOKEN,
// `KORTIX_PROJECT_SECRET_NAMES` did not, and no process in the sandbox carried
// the variable.

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

const envFor = (rows: ResolvedProjectSecret[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.key, r.value]));

const materialize = (rows: ResolvedProjectSecret[], env: Record<string, string>, gateway: boolean) =>
  materializeSecretDelivery(rows, env, {
    sessionId: 'sess-1',
    grantEnv: 'all',
    llmGatewayEnabled: gateway,
    mintHandleFor: async () => 'handle-should-not-be-minted',
  });

describe('gatewayStripsRow', () => {
  // The regression. `GITHUB_TOKEN` is a gateway-managed NAME only because
  // models.dev's `github-copilot` provider declares it; a project's own secret
  // carrying that name must still reach the box.
  test("a project's own sandbox secret survives a gateway-managed NAME", () => {
    expect(
      gatewayStripsRow({ llmGatewayEnabled: true, nameIsGatewayManaged: true, consumer: 'sandbox' }),
    ).toBe(false);
  });

  test('a real gateway credential is still stripped', () => {
    expect(
      gatewayStripsRow({
        llmGatewayEnabled: true,
        nameIsGatewayManaged: true,
        consumer: 'llm_gateway',
      }),
    ).toBe(true);
  });

  test('a legacy row with no consumer stamp keeps the old behavior — no widening', () => {
    expect(
      gatewayStripsRow({ llmGatewayEnabled: true, nameIsGatewayManaged: true, consumer: null }),
    ).toBe(true);
    expect(
      gatewayStripsRow({
        llmGatewayEnabled: true,
        nameIsGatewayManaged: true,
        consumer: undefined,
      }),
    ).toBe(true);
  });

  test('gateway off strips nothing by name', () => {
    expect(
      gatewayStripsRow({
        llmGatewayEnabled: false,
        nameIsGatewayManaged: true,
        consumer: 'llm_gateway',
      }),
    ).toBe(false);
  });

  test('an ordinary name is never stripped', () => {
    expect(
      gatewayStripsRow({ llmGatewayEnabled: true, nameIsGatewayManaged: false, consumer: null }),
    ).toBe(false);
  });
});

describe('capabilities never advertise a value the env does not hold', () => {
  test('materializeSecretDelivery returns only the rows it actually delivered', async () => {
    const kept = row('ui-auth', 'UI_AUTH_STATE_JSON', { strategy: 'runtime', consumer: 'sandbox' });
    // `denied` forces the withhold path, which deletes the key from env.
    const dropped = row('nope', 'NOPE_TOKEN', { strategy: 'denied', consumer: 'sandbox' });
    const env = envFor([kept, dropped]);

    const delivered = await materialize([kept, dropped], env, true);

    expect(Object.keys(env).sort()).toEqual(['UI_AUTH_STATE_JSON']);
    // The invariant `secretNamesForSandbox` documents: a name is advertised IFF
    // a value is emitted. Building capabilities from the input list broke it.
    expect(delivered.map((r) => r.key)).toEqual(['UI_AUTH_STATE_JSON']);
  });

  test('a sandbox-consumer GITHUB_TOKEN keeps its plaintext and is reported delivered', async () => {
    const github = row('github', 'GITHUB_TOKEN', { strategy: 'runtime', consumer: 'sandbox' });
    const env = envFor([github]);

    const delivered = await materialize([github], env, true);

    expect(env.GITHUB_TOKEN).toBe('value-of-github');
    expect(delivered.map((r) => r.key)).toEqual(['GITHUB_TOKEN']);
  });
});
