import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { ModelsTabView } from './models-tab';

/**
 * `ModelsTabView` is the pure, props-only half (see the tab's header comment).
 * `gatewaySlot` stands in for `LlmManagementView`, which cannot render under
 * `renderToStaticMarkup` with no provider tree — same reasoning as
 * `instructions-tab.test.tsx`'s `commandsSlot`.
 */
describe('ModelsTabView', () => {
  test('renders the gateway slot it is given', () => {
    const out = renderToStaticMarkup(<ModelsTabView gatewaySlot={<div>gateway-marker</div>} />);
    expect(out).toContain('gateway-marker');
  });

  test('renders empty with no slot — the bare view needs no providers', () => {
    expect(renderToStaticMarkup(<ModelsTabView />)).toBe('');
  });
});

/**
 * Strip block and line comments before asserting. A bare `toContain` over a
 * whole file matches its own doc comment — the first cut of these tests failed
 * for exactly that reason, which is the "a grep is only evidence if it matches
 * the thing you mean" rule showing up inside a test.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
}

const tabSource = code(join(import.meta.dir, 'models-tab.tsx'));
const gatewaySource = code(join(import.meta.dir, '../../customize/sections/gateway-view.tsx'));

describe('Models tab — gate and gateway sub-sections', () => {
  test('renders nothing while the gateway is disabled, matching the panel it replaced', () => {
    // The gate is the flag the panel threads in, NOT a second derivation.
    expect(tabSource).toContain('if (!llmGatewayEnabled) return null;');
    expect(tabSource).not.toContain('isLlmGatewayEnabled(');
    expect(tabSource).not.toContain('llmGatewayAvailable');
  });

  test('keeps every llm-* gateway sub-section, and its deep-link map', () => {
    for (const label of [
      'Providers',
      'Overview',
      'Logs',
      'Budgets',
      'API keys',
      'API',
      'Routing',
      'Playground',
    ]) {
      expect(gatewaySource).toContain(`label: '${label}'`);
    }
    // The six legacy `llm-*` ids that name a sub-section still map to one.
    for (const legacy of [
      'llm-management',
      'llm-providers',
      'llm-overview',
      'llm-logs',
      'llm-budgets',
      'llm-keys',
      'llm-api',
    ]) {
      expect(gatewaySource).toContain(`'${legacy}'`);
    }
  });

  test('the Providers sub-section mounts ProviderConnect directly — no dialog', () => {
    expect(gatewaySource).toContain('<ProviderConnect projectId={projectId}');
    expect(gatewaySource).not.toContain('ProjectProviderModal');
  });

  test('the model-visibility list kept a home as a sibling sub-section', () => {
    expect(gatewaySource).toContain("{ id: 'models', label: 'Models' }");
    expect(gatewaySource).toContain('<ModelsTab projectId={projectId} />');
  });
});
