import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

let customProviders: unknown[] = [];
mock.module('../repositories/project-model-access', () => ({
  getProjectModelAccess: async () => ({ disabledProviders: [], disabledModels: [] }),
  getProjectGatewayResolution: async () => ({
    access: { disabledProviders: [], disabledModels: [] }, pooledEnabled: false, customProviders,
  }),
}));
let keys: Array<{ identifier: string; secretId?: string; value: string }> = [];
const resolveProjectSecretsForConsumer = mock(async (_input: { name: string }) => keys);
const realSecrets = await import('../projects/secrets');
mock.module('../projects/secrets', () => ({ ...realSecrets, resolveProjectSecretsForConsumer }));

const {
  customProviderCatalog, customProviderIdError, customProviderIdFromSecret, customProviderSecretName,
  CustomLlmProviderInputSchema, upsertCustomProvider,
} = await import('./custom-providers');
const { resolveCandidates } = await import('./resolution/resolve-candidates');

const railway = { id: 'railway', name: 'Railway', base_url: 'https://llm.example.com/v1', models: [{ id: 'kimi-for-coding', name: 'Kimi' }] };
const principal = { accountId: 'acc', projectId: 'proj', userId: 'user', sessionId: 'sess' } as never;

describe('custom provider definitions', () => {
  test('the key name round-trips through the secret name the old form wrote', () => {
    expect(customProviderSecretName('my-llm')).toBe('CUSTOM_MY_LLM_API_KEY');
    expect(customProviderIdFromSecret('CUSTOM_MY_LLM_API_KEY')).toBe('my_llm');
    expect(customProviderIdFromSecret('OPENAI_API_KEY')).toBeNull();
  });

  test('a catalog or gateway provider id is reserved, a bad id is invalid', () => {
    expect(customProviderIdError('anthropic')).toBe('reserved_provider_id');
    expect(customProviderIdError('kortix')).toBe('reserved_provider_id');
    expect(customProviderIdError('My LLM')).toBe('invalid_body');
    expect(customProviderIdError('my-llm')).toBeNull();
  });

  test('input refuses credentials in the URL and whitespace in a model id', () => {
    const base = { name: 'X', base_url: 'https://h.example/v1', models: [{ id: 'm', name: 'M' }] };
    expect(CustomLlmProviderInputSchema.safeParse(base).success).toBe(true);
    expect(CustomLlmProviderInputSchema.safeParse({ ...base, base_url: 'https://u:p@h.example' }).success).toBe(false);
    expect(CustomLlmProviderInputSchema.safeParse({ ...base, base_url: 'ftp://h.example' }).success).toBe(false);
    expect(CustomLlmProviderInputSchema.safeParse({ ...base, models: [{ id: 'a b', name: 'M' }] }).success).toBe(false);
    expect(CustomLlmProviderInputSchema.safeParse({ ...base, models: [] }).success).toBe(false);
  });

  test('upsert replaces by id, strips the provider prefix and a trailing slash, and sorts', () => {
    const list = upsertCustomProvider([railway], 'acme', {
      name: 'Acme', base_url: 'http://acme.example/v1/', models: [{ id: 'acme/m1', name: 'M1' }, { id: 'm1', name: 'M1 again' }],
    });
    expect(list.map((p) => p.id)).toEqual(['acme', 'railway']);
    expect(list[0]).toEqual({ id: 'acme', name: 'Acme', base_url: 'http://acme.example/v1', models: [{ id: 'm1', name: 'M1 again' }] });
    expect(upsertCustomProvider(list, 'railway', { ...railway, models: [{ id: 'k2', name: 'K2' }] })[1]!.models).toEqual([{ id: 'k2', name: 'K2' }]);
  });

  test('the served catalog names each model <provider>/<model>', () => {
    expect(customProviderCatalog([railway])).toEqual({
      'railway/kimi-for-coding': expect.objectContaining({ name: 'Kimi', provider: 'railway', provider_name: 'Railway', tool_call: true }),
    });
  });
});

describe('resolveCandidates for a custom provider', () => {
  beforeEach(() => { customProviders = [railway]; keys = []; resolveProjectSecretsForConsumer.mockClear(); });

  test('a keyed model resolves to one guarded, BYOK-billed openai-compat upstream', async () => {
    keys = [{ identifier: 'CUSTOM_RAILWAY_API_KEY', secretId: 'sec_1', value: 'sk-1' }];
    const [descriptor, ...rest] = await resolveCandidates(principal, 'kortix/railway/kimi-for-coding');
    expect(rest).toEqual([]);
    expect(descriptor).toMatchObject({
      provider: 'railway', kind: 'openai-compat', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-1',
      credentialRef: 'sec_1', billingMode: 'none', markup: 0, resolvedModel: 'kimi-for-coding',
      egress: { allowPrivateHosts: [] },
    });
    expect(descriptor!.omitAuthorization).toBeUndefined();
    expect(resolveProjectSecretsForConsumer.mock.calls[0]![0]).toMatchObject({ name: 'CUSTOM_RAILWAY_API_KEY', consumer: 'llm_gateway' });
  });

  test('without a key the request carries no Authorization header', async () => {
    const [descriptor] = await resolveCandidates(principal, 'railway/kimi-for-coding');
    expect(descriptor).toMatchObject({ apiKey: '', omitAuthorization: true });
  });

  test('a model the provider does not list is model_not_found', async () => {
    const error = await resolveCandidates(principal, 'railway/other').catch((e) => e);
    expect(error).toBeInstanceOf(GatewayResolutionError);
    expect((error as GatewayResolutionError).code).toBe('model_not_found');
  });
});
