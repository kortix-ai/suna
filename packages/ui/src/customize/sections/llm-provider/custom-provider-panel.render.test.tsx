import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CustomLlmProvider } from '@kortix/sdk';

import { CustomProviderForm } from './custom-provider-form';
import { CustomProviderRow } from './custom-provider-panel';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );

const provider = (overrides: Partial<CustomLlmProvider> = {}): CustomLlmProvider => ({
  id: 'example-inference',
  name: 'Example Inference',
  base_url: 'https://api.example.com/v1',
  models: [
    { id: 'model-one', name: 'Model One' },
    { id: 'model-two', name: 'Model Two' },
  ],
  secret_name: 'CUSTOM_EXAMPLE_INFERENCE_API_KEY',
  has_key: true,
  configured: true,
  ...overrides,
});

describe('CustomProviderForm — Paper board CP01', () => {
  const out = render(<CustomProviderForm projectId="p" />);

  test('every field, in the board order', () => {
    const order = [
      'custom-display-name',
      'custom-provider-id',
      'custom-base-url',
      'custom-api-key',
      'custom-model-id',
      'custom-model-name',
    ];
    const positions = order.map((id) => out.indexOf(`id="${id}"`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('the API key is masked and the button names what it does', () => {
    expect(out).toMatch(
      /id="custom-api-key"[^>]*type="password"|type="password"[^>]*id="custom-api-key"/,
    );
    expect(out).toContain('Save provider');
    expect(out).not.toContain('snippet');
  });

  test('says the requests go through the gateway, without Kortix credits', () => {
    expect(out).toContain('Requests go through the Kortix gateway');
    expect(out).toContain('no Kortix credits are used');
  });

  test('a legacy key pre-fills the provider id', () => {
    const html = render(<CustomProviderForm projectId="p" initialId="legacy-llm" />);
    expect(html).toMatch(/id="custom-provider-id"[^>]*value="legacy-llm"|value="legacy-llm"[^>]*id="custom-provider-id"/);
  });
});

describe('CustomProviderRow — board CP02', () => {
  test('a configured row: the check, the endpoint and the model count', () => {
    const out = renderToStaticMarkup(
      <CustomProviderRow provider={provider()} selected onSelect={() => {}} />,
    );
    expect(out).toContain('data-custom-provider-row="example-inference"');
    expect(out).toContain('aria-current="true"');
    expect(out).toContain('aria-label="Connected"');
    expect(out).toContain('Example Inference');
    expect(out).toContain('https://api.example.com/v1');
    expect(out).toContain('2 models');
  });

  test('a legacy key with no endpoint asks for one', () => {
    const out = renderToStaticMarkup(
      <CustomProviderRow
        provider={provider({ base_url: null, models: [], configured: false, name: 'legacy-llm' })}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(out).toContain('Add endpoint');
    expect(out).toContain('Key saved. Add the endpoint to use it.');
    expect(out).not.toContain('aria-label="Connected"');
  });

  test('no runtime configuration path anywhere', () => {
    const html =
      render(<CustomProviderForm projectId="synthetic-project" />) +
      renderToStaticMarkup(<CustomProviderRow provider={provider()} selected={false} onSelect={() => {}} />);
    expect(html).not.toContain('.opencode');
    expect(html).not.toContain('opencode.jsonc');
    expect(html).not.toContain('@ai-sdk/openai-compatible');
    expect(html).not.toContain('provider configuration');
  });
});
