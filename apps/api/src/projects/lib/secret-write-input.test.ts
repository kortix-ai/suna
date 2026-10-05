import { describe, expect, test } from 'bun:test';
import { resolveSecretWriteInput } from './secret-write-input';

// `MS_TEAMS_TENANT_ID` once chose whose Microsoft Graph data the Teams
// connector read, with the managed app every customer shares. A project writer
// could set it to another customer's tenant through this API (2026-09-29
// permissions audit). The Teams connection owns every `MS_TEAMS_*` name.
describe('resolveSecretWriteInput: names another part of Kortix owns', () => {
  test.each(['MS_TEAMS_TENANT_ID', 'ms_teams_app_password', 'MS_TEAMS_SERVICE_URL'])('%s is refused', (name) => {
    const result = resolveSecretWriteInput({ name, value: 'x' }, false);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(JSON.stringify(result)).toContain('Microsoft Teams connection');
  });

  test('a look-alike name that is not in the reserved namespace is accepted', () => {
    expect(resolveSecretWriteInput({ name: 'TEAMS_WEBHOOK_URL', value: 'x' }, false)).toMatchObject({ ok: true });
    expect(resolveSecretWriteInput({ name: 'MY_MS_TEAMS_NOTE', value: 'x' }, false)).toMatchObject({ ok: true });
  });
});

// CHARACTERIZATION of the strategy→consumer contract: which consumer each
// delivery strategy accepts, and the consumer a bare strategy is completed
// with. The route-level table in routes/secret-create-validation.test.ts pins
// the rejected combinations with their exact messages through HTTP; these pin
// the accepted parses (and the defaulted consumer) at the resolver itself.
describe('resolveSecretWriteInput: the strategy→consumer contract', () => {
  const OK_POLICY = { rules: [{ host: 'api.example.com' }] };

  test.each([
    [{ name: 'K', value: 'x' }, { explicitStrategy: undefined, explicitConsumer: undefined, explicitPolicy: null }],
    // A bare strategy is completed with its pinned consumer.
    [{ name: 'K', value: 'x', strategy: 'runtime' }, { explicitStrategy: 'runtime', explicitConsumer: 'sandbox' }],
    [{ name: 'K', value: 'x', strategy: 'runtime', consumer: 'sandbox' }, { explicitConsumer: 'sandbox' }],
    [
      { name: 'K', value: 'x', strategy: 'egress', consumer: 'network', egress_policy: OK_POLICY },
      { explicitStrategy: 'egress', explicitConsumer: 'network' },
    ],
    [{ name: 'K', value: 'x', strategy: 'denied' }, { explicitStrategy: 'denied', explicitConsumer: null }],
    [{ name: 'K', value: 'x', strategy: 'denied', consumer: null }, { explicitStrategy: 'denied', explicitConsumer: null }],
    [{ name: 'K', value: 'x', strategy: 'broker', consumer: 'llm_gateway' }, { explicitConsumer: 'llm_gateway', explicitPolicy: null }],
    [{ name: 'K', value: 'x', strategy: 'broker', consumer: 'connector' }, { explicitConsumer: 'connector' }],
    [
      { name: 'K', value: 'x', strategy: 'broker', consumer: 'http_broker', egress_policy: { ...OK_POLICY, backend: 'kortix_fetch' } },
      { explicitConsumer: 'http_broker' },
    ],
  ])('%o → ok', (body, expected) => {
    const result = resolveSecretWriteInput(body as Record<string, unknown>, false);
    expect(result).toMatchObject({ ok: true, input: expected });
  });

  test.each([
    [{ name: 'K', value: 'x', strategy: 'broker' }, 'broker creation requires a supported server consumer'],
    [{ name: 'K', value: 'x', strategy: 'broker', consumer: 'sandbox' }, 'broker creation requires a supported server consumer'],
    [{ name: 'K', value: 'x', strategy: 'runtime', consumer: 'connector' }, 'runtime creation requires the sandbox consumer'],
    [{ name: 'K', value: 'x', strategy: 'egress', consumer: 'sandbox' }, 'egress creation requires the network consumer'],
    [{ name: 'K', value: 'x', strategy: 'denied', consumer: 'sandbox' }, 'denied creation cannot have a consumer'],
    [{ name: 'K', value: 'x', consumer: 'sandbox' }, 'consumer requires a strategy'],
  ])('%o → refused: %s', (body, error) => {
    expect(resolveSecretWriteInput(body as Record<string, unknown>, false)).toEqual({
      ok: false,
      status: 400,
      body: { error },
    });
  });

  test('egress delivery requires an outbound policy body', () => {
    expect(resolveSecretWriteInput({ name: 'K', value: 'x', strategy: 'egress' }, false)).toEqual({
      ok: false,
      status: 400,
      body: { error: 'policy must be an object', code: 'secret_delivery_policy_invalid' },
    });
  });
});
