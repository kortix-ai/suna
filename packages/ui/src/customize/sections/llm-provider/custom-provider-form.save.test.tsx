import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const calls: string[] = [];
const successToast = mock(() => {});
const errorToast = mock(() => {});
const upsertProjectSecret = mock(async (_projectId: string, input: { name: string }) => {
  calls.push(`secret:${input.name}`);
});
const save = mock(async (providerId: string, _input: unknown) => {
  calls.push(`save:${providerId}`);
});
let providers: unknown[] = [];

mock.module('../../../primitives/toast', () => ({ successToast, errorToast }));
const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({ ...realSdk, upsertProjectSecret }));
const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useCustomLlmProviders: () => ({
    providers,
    isLoading: false,
    error: null,
    save,
    remove: async () => {},
    isSaving: false,
  }),
}));

const { CustomProviderForm } = await import('./custom-provider-form');

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  calls.length = 0;
  providers = [];
  save.mockClear();
  upsertProjectSecret.mockClear();
  successToast.mockClear();
});

async function submit(values: Record<string, string>, onSaved?: (id: string) => void) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <CustomProviderForm projectId="synthetic-project" onSaved={onSaved} />
      </QueryClientProvider>,
    );
  });
  for (const [id, value] of Object.entries(values)) {
    await act(async () => renderer.root.findByProps({ id }).props.onChange({ target: { value } }));
  }
  await act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const fields = {
  'custom-display-name': 'Example',
  'custom-provider-id': 'example-llm',
  'custom-base-url': 'https://api.example.com/v1',
  'custom-model-id': 'model-one',
  'custom-model-name': 'Model One',
};

describe('CustomProviderForm save', () => {
  test('stores the key as a gateway broker secret, then the endpoint', async () => {
    const saved = mock((_id: string) => {});
    await submit({ ...fields, 'custom-api-key': 'synthetic-key' }, saved);
    expect(save).toHaveBeenCalledWith('example-llm', {
      name: 'Example',
      base_url: 'https://api.example.com/v1',
      models: [{ id: 'model-one', name: 'Model One' }],
    });
    expect(upsertProjectSecret).toHaveBeenCalledWith('synthetic-project', {
      name: 'CUSTOM_EXAMPLE_LLM_API_KEY',
      value: 'synthetic-key',
      strategy: 'broker',
      consumer: 'llm_gateway',
    });
    // Key first, on purpose: saving the endpoint reads its GET /models for each
    // model's context window and limits, and that call needs the credential.
    expect(calls).toEqual(['secret:CUSTOM_EXAMPLE_LLM_API_KEY', 'save:example-llm']);
    expect(saved).toHaveBeenCalledWith('example-llm');
    expect(successToast).toHaveBeenCalledTimes(1);
  });

  test('no key typed: no secret write', async () => {
    await submit(fields);
    expect(save).toHaveBeenCalledTimes(1);
    expect(upsertProjectSecret).not.toHaveBeenCalled();
  });

  test('saving an existing id keeps its other models (the PUT replaces the list)', async () => {
    providers = [
      {
        id: 'example-llm',
        name: 'Example',
        base_url: 'https://old.example.com/v1',
        models: [
          { id: 'model-zero', name: 'Model Zero' },
          { id: 'model-one', name: 'Old name' },
        ],
        secret_name: 'CUSTOM_EXAMPLE_LLM_API_KEY',
        has_key: true,
        configured: true,
      },
    ];
    await submit(fields);
    expect(save).toHaveBeenCalledWith('example-llm', {
      name: 'Example',
      base_url: 'https://api.example.com/v1',
      models: [
        { id: 'model-zero', name: 'Model Zero' },
        { id: 'model-one', name: 'Model One' },
      ],
    });
  });

  test('an invalid base URL never reaches the API', async () => {
    await submit({ ...fields, 'custom-base-url': 'api.example.com' });
    expect(save).not.toHaveBeenCalled();
    expect(upsertProjectSecret).not.toHaveBeenCalled();
  });
});
