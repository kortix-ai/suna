import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GatewayPlaygroundResult } from '@/lib/projects-gateway-client';

import { fmtLatency, PlaygroundResultCard } from './gateway-playground';

const result = (overrides: Partial<GatewayPlaygroundResult> = {}): GatewayPlaygroundResult => ({
  model: 'gpt-4o',
  ok: true,
  latency_ms: 842,
  output: 'Hello from the model.',
  input_tokens: 12,
  output_tokens: 34,
  cost: 0.0031,
  resolved_model: 'gpt-4o-2026-01-01',
  provider: 'openrouter',
  ...overrides,
});

function render(r: GatewayPlaygroundResult) {
  return renderToStaticMarkup(createElement(PlaygroundResultCard, { result: r }));
}

describe('fmtLatency', () => {
  test('renders sub-second latency in milliseconds', () => {
    expect(fmtLatency(842)).toBe('842ms');
  });

  test('renders one-second-plus latency in seconds with one decimal', () => {
    expect(fmtLatency(1500)).toBe('1.5s');
    expect(fmtLatency(12345)).toBe('12.3s');
  });
});

describe('PlaygroundResultCard', () => {
  test('a successful run shows the output, usage, cost, and latency', () => {
    const html = render(result());

    expect(html).toContain('Hello from the model.');
    expect(html).toContain('842ms');
    expect(html).toContain('12 in');
    expect(html).toContain('34 out');
    expect(html).toContain('OK');
    expect(html).not.toContain('Failed');
  });

  test('shows the resolved upstream model alongside the requested id when they differ', () => {
    const html = render(result({ model: 'auto/gpt', resolved_model: 'gpt-4o-2026-01-01' }));

    expect(html).toContain('auto/gpt');
  });

  test('a failed run shows the error instead of output, with no usage row', () => {
    const html = render(
      result({
        ok: false,
        output: undefined,
        input_tokens: undefined,
        output_tokens: undefined,
        cost: undefined,
        error: 'No upstream configured for this model',
      }),
    );

    expect(html).toContain('No upstream configured for this model');
    expect(html).toContain('Failed');
    expect(html).not.toContain('Hello from the model.');
  });

  test('an empty successful response still reads as ok, not an error', () => {
    const html = render(result({ output: '' }));

    expect(html).toContain('Empty response.');
    expect(html).toContain('OK');
  });
});
