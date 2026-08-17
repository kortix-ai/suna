import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { ModelsTabView } from './models-tab';

/**
 * `ModelsTabView` is the pure, props-only half (see the tab's header comment).
 * `gatewaySlot` stands in for `LlmManagementView`, which cannot render under
 * `renderToStaticMarkup` with no provider tree — same reasoning as
 * `sandbox-tab.test.tsx`'s `templatesSlot`.
 */
describe('ModelsTabView', () => {
  test('renders the pane heading and the gateway slot it is given', () => {
    const out = renderToStaticMarkup(<ModelsTabView gatewaySlot={<div>gateway-marker</div>} />);
    expect(out).toContain('Models');
    expect(out).toContain('gateway-marker');
  });

  test('renders the pane heading with no slot — the bare view needs no providers', () => {
    const out = renderToStaticMarkup(<ModelsTabView />);
    expect(out).toContain('Models');
  });
});

/**
 * Page chrome. Models is a sibling tab of Connectors / Agents / Skills /
 * Triggers / Secrets on the Customize bar and has to read as one: same
 * `CapabilityPageShell`, same `max-w-5xl` column, same heading, same header
 * group. It brought its own `flex h-full min-h-0 flex-col` box and its own
 * `SettingsSectionHeader` strip before, which is what made it look like a
 * different product beside its five siblings.
 *
 * Source-level assertions, following `schedule-view.test.tsx` and
 * `secrets-view.chrome.test.ts`: apps/web has no DOM testing library, and
 * what is pinned here is WHERE a control is mounted, not what it renders.
 */
describe('ModelsTabView page chrome', () => {
  test('the page is the shared capability shell, not its own header strip', () => {
    const shellStart = tabSource.indexOf('<CapabilityPageShell');
    expect(shellStart).toBeGreaterThan(-1);
    expect(tabSource).toContain('title="Models"');
    expect(tabSource).toContain(
      'description="Which providers and models this project can use."',
    );
    // The two pieces of the old bespoke layout, gone for good.
    expect(tabSource).not.toContain('SettingsSectionHeader');
    expect(tabSource).not.toContain('SettingsTabHeader');
    expect(tabSource).not.toContain('CustomizeSectionWrapper');
    expect(tabSource).not.toContain("className=\"flex h-full min-h-0 flex-col\"");
  });

  test('the gateway slot is the shell’s children, not a hand-rolled min-h-0 wrapper', () => {
    const shellStart = tabSource.indexOf('<CapabilityPageShell');
    const shellBody = tabSource.slice(shellStart);
    expect(shellBody).toContain('{gatewaySlot}');
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
const keysTabSource = code(join(import.meta.dir, '../../customize/sections/gateway-access-tab.tsx'));
const overviewSource = code(
  join(import.meta.dir, '../../customize/sections/view/gateway/gateway-overview.tsx'),
);
const playgroundPath = '../../customize/sections/view/gateway/gateway-playground.tsx';

describe('Models tab — gate and gateway sub-sections', () => {
  test('renders nothing while the gateway is disabled, matching the panel it replaced', () => {
    // The gate is the flag the panel threads in, NOT a second derivation.
    expect(tabSource).toContain('if (!llmGatewayEnabled) return null;');
    expect(tabSource).not.toContain('isLlmGatewayEnabled(');
    expect(tabSource).not.toContain('llmGatewayAvailable');
  });

  test('the gateway bar is the six tabs left after the merge, in work order', () => {
    // Pinned as id+label PAIRS, not bare labels — a bare-label check could
    // pass against a comment or against the wrong tab.
    for (const pair of [
      "{ id: 'providers', label: 'API keys' }",
      "{ id: 'models', label: 'Models' }",
      "{ id: 'custom', label: 'Custom' }",
      "{ id: 'routing', label: 'Routing' }",
      "{ id: 'overview', label: 'Costs' }",
      "{ id: 'logs', label: 'Logs' }",
    ]) {
      expect(gatewaySource).toContain(pair);
    }
    // API keys leads; Overview is NOT first — a dashboard is where you arrive
    // second, and nothing else on this screen works without a key.
    const ids = [...gatewaySource.matchAll(/\{ id: '(\w+)', label: '[^']+' \}/g)].map((m) => m[1]);
    expect(ids).toEqual(['providers', 'models', 'custom', 'routing', 'overview', 'logs']);
  });

  test('the three merged-away tabs are gone from the bar and from the tree', () => {
    // Playground deleted outright; `keys` + `api` are sections of the API-keys
    // tab; `budgets` is a section of Overview. None may return as a tab.
    for (const dead of [
      "id: 'playground'",
      "id: 'budgets'",
      "id: 'keys'",
      "id: 'api'",
      'GatewayPlayground',
    ]) {
      expect(gatewaySource).not.toContain(dead);
    }
    expect(existsSync(join(import.meta.dir, playgroundPath))).toBe(false);
  });

  test('every legacy llm-* deep link still lands on the tab that absorbed it', () => {
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
    // The three whose own tab is gone are re-pointed, not dropped.
    expect(gatewaySource).toContain("'llm-budgets': 'overview'");
    expect(gatewaySource).toContain("'llm-keys': 'providers'");
    expect(gatewaySource).toContain("'llm-api': 'providers'");
  });

  test('the API-keys tab mounts all three key surfaces, in one panel', () => {
    expect(gatewaySource).toContain('<LlmApiKeysTab');
    expect(keysTabSource).toContain('<ProviderConnect');
    expect(keysTabSource).toContain('<GatewayKeys');
    expect(keysTabSource).toContain('<GatewayApiReference');
  });

  test('Overview carries the budget section that used to be its own tab', () => {
    expect(overviewSource).toContain('<GatewayBudgetSection');
    expect(gatewaySource).toContain(
      '<GatewayOverview projectId={projectId} canWrite={canWrite} />',
    );
  });

  // JAY-510's invariant, one level down now that the provider list is a
  // section of `gateway-access-tab.tsx`: still mounted directly, still no dialog.
  test('the provider list mounts ProviderConnect directly — no dialog', () => {
    expect(keysTabSource).toContain('<ProviderConnect');
    expect(keysTabSource).not.toContain('ProjectProviderModal');
    expect(gatewaySource).not.toContain('ProjectProviderModal');
  });

  test('the model-visibility list kept a home as a sibling sub-section', () => {
    expect(gatewaySource).toContain("{ id: 'models', label: 'Models' }");
    expect(gatewaySource).toContain('<ModelsTab projectId={projectId} />');
  });
});
