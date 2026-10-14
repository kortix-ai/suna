import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import { CustomProviderForm } from './custom-provider-form';
import { CustomProviderRow } from './custom-provider-panel';

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('CustomProviderForm — Paper board CP01', () => {
  const out = render(<CustomProviderForm projectId="p" onDone={() => {}} />);

  test('every field, in the board order', () => {
    const order = ['custom-display-name', 'custom-provider-id', 'custom-base-url', 'custom-api-key', 'custom-model-id', 'custom-model-name'];
    const positions = order.map((id) => out.indexOf(`id="${id}"`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('the API key is masked and the button names what it does', () => {
    expect(out).toMatch(/id="custom-api-key"[^>]*type="password"|type="password"[^>]*id="custom-api-key"/);
    expect(out).toContain('Save and generate snippet');
  });

  test('a live preview of the snippet sits beside the form', () => {
    expect(out).toContain('data-custom-provider-preview');
    expect(out).not.toContain('Live preview');
    expect(out).toMatch(/<button[^>]*>[\s\S]*?Copy<\/button>/);
    expect(out).toContain('@ai-sdk/openai-compatible');
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
    expect(out).toContain('.opencode/opencode.jsonc');
  });
});
