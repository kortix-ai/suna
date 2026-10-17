import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CustomProviderForm } from './custom-provider-form';
import { CustomProviderRow } from './custom-provider-panel';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );

describe('CustomProviderForm — Paper board CP01', () => {
  const out = render(<CustomProviderForm projectId="p" onDone={() => {}} />);

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
    expect(out).toContain('Save and generate snippet');
  });
});

describe('CustomProviderRow — board CP02', () => {
  test('a row with the green check and where the provider is declared', () => {
    const out = renderToStaticMarkup(
      <CustomProviderRow id="acme-inference" selected onSelect={() => {}} />,
    );
    expect(out).toContain('data-custom-provider-row="acme-inference"');
    expect(out).toContain('aria-current="true"');
    expect(out).toContain('aria-label="Connected"');
    expect(out).toContain('provider configuration');
  });
});

describe('Custom harness-neutral presentation regression', () => {
  test('keeps all six editable fields without a generated runtime example', () => {
    const html = render(<CustomProviderForm projectId="synthetic-project" onDone={() => {}} />);
    expect((html.match(/<input/g) ?? []).length).toBe(6);
    expect(html).toContain('@container/custom-provider');
    expect(html).toContain('@4xl/custom-provider:w-141');
    expect(html).toContain('@4xl/custom-provider:shrink-0');
    expect(html).not.toContain('<figure');
    expect(html).not.toContain('@ai-sdk/openai-compatible');
    expect(html).not.toContain('.opencode');
  });
  test('saved provider identity does not expose a runtime configuration path', () => {
    const html = render(
      <CustomProviderRow id="example-provider" selected={false} onSelect={() => {}} />,
    );
    expect(html).toContain('example-provider');
    expect(html).not.toContain('.opencode');
    expect(html).not.toContain('opencode.jsonc');
  });
});
