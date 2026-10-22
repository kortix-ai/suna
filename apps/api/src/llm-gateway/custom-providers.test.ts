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
let modelsResponse: () => Response = () => Response.json({ data: [] });
const safeEgressFetch = mock(async (_url: string, _init?: { headers?: Record<string, string> }) => modelsResponse());
const realGuard = await import('../shared/ssrf-guard');
mock.module('../shared/ssrf-guard', () => ({ ...realGuard, safeEgressFetch }));

const {
  customProviderCatalog, customProviderIdError, customProviderIdFromSecret, customProviderSecretName,
  CustomLlmProviderInputSchema, probeCustomModels, upsertCustomProvider,
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

  test('a model serves its own limits; output falls back to the context, then 128k/16k', () => {
    const limits = (models: { id: string; name: string; context?: number; output?: number }[]) =>
      Object.values(customProviderCatalog([{ ...railway, models }])).map((m) => m.limit);
    expect(limits([{ id: 'a', name: 'A', context: 1_048_576, output: 393_216 }])).toEqual([{ context: 1_048_576, output: 393_216 }]);
    expect(limits([{ id: 'a', name: 'A', context: 1_048_576 }])).toEqual([{ context: 1_048_576, output: 1_048_576 }]);
    expect(limits([{ id: 'a', name: 'A' }])).toEqual([{ context: 128_000, output: 16_000 }]);
  });

  test('a model that reads images or reasons serves it, with the effort levels', () => {
    const [m] = Object.values(customProviderCatalog([{ ...railway, models: [{ id: 'a', name: 'A', attachment: true, reasoning: true }] }]));
    expect(m).toMatchObject({ attachment: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] });
    const [plain] = Object.values(customProviderCatalog([railway]));
    expect(plain).toMatchObject({ attachment: false, reasoning: false });
    expect(plain).not.toHaveProperty('reasoning_options');
  });

  test('upsert: an explicit switch wins over the endpoint, an unknown trait stays unset', () => {
    const detected = new Map([['m', { attachment: false, reasoning: true }]]);
    const [saved] = upsertCustomProvider([], 'p', { name: 'P', base_url: 'https://h.example/v1', models: [{ id: 'm', name: 'M', attachment: true }] }, detected);
    expect(saved!.models).toEqual([{ id: 'm', name: 'M', attachment: true, reasoning: true }]);
  });

  test('upsert stores detected limits; a limit in the input wins', () => {
    const detected = new Map([['m', { context: 1_048_576, output: 65_536 }]]);
    const [saved] = upsertCustomProvider([], 'p', { name: 'P', base_url: 'https://h.example/v1', models: [{ id: 'm', name: 'M', output: 8_000 }] }, detected);
    expect(saved!.models).toEqual([{ id: 'm', name: 'M', context: 1_048_576, output: 8_000 }]);
  });
});

describe('probeCustomModels', () => {
  test('reads context_window, max_model_len, context_length and output fields, with the key', async () => {
    modelsResponse = () => Response.json({ data: [
      { id: 'morph', context_window: 1_048_576 },
      { id: 'vllm', max_model_len: 262_144 },
      {
        id: 'or', context_length: 200_000, top_provider: { max_completion_tokens: 64_000 },
        architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning'],
      },
      { id: 'text-only', context_length: 32_000, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools'] },
      { id: 'bare' },
    ] });
    const traits = await probeCustomModels('https://h.example/v1/', 'sk-1');
    const none = { output: undefined, attachment: undefined, reasoning: undefined };
    expect(Object.fromEntries(traits)).toEqual({
      morph: { ...none, context: 1_048_576 },
      vllm: { ...none, context: 262_144 },
      or: { context: 200_000, output: 64_000, attachment: true, reasoning: true },
      'text-only': { context: 32_000, output: undefined, attachment: false, reasoning: false },
    });
    expect(safeEgressFetch.mock.calls.at(-1)![0]).toBe('https://h.example/v1/models');
    expect(safeEgressFetch.mock.calls.at(-1)![1]!.headers).toEqual({ authorization: 'Bearer sk-1' });
  });

  test('a refused, failing or malformed endpoint yields no limits', async () => {
    modelsResponse = () => new Response('no', { status: 401 });
    expect((await probeCustomModels('https://h.example/v1', null)).size).toBe(0);
    modelsResponse = () => { throw new Error('ECONNREFUSED'); };
    expect((await probeCustomModels('https://h.example/v1', null)).size).toBe(0);
    modelsResponse = () => new Response('<html>');
    expect((await probeCustomModels('https://h.example/v1', null)).size).toBe(0);
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
