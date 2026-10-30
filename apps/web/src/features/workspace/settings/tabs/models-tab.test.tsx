import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LLM_TABS,
  LlmTabStrip,
  MODELS_PAGE_DESCRIPTION,
  MODELS_PAGE_TITLE,
  QUICK_LLM_TABS,
} from '@kortix/ui/customize/sections/gateway-view';
import { uiSourcePath } from '@/test-utils/read-source';

/**
 * `LlmTabStrip` is the pure, props-only half of the Models page — no hooks, so
 * it renders under `renderToStaticMarkup` with no provider tree (the repo's
 * only render-assertion idiom; there is no DOM testing library in `apps/web`
 * and none may be added). `LlmManagementView`, which owns the state and the
 * five data hooks around it, cannot.
 *
 * This replaced `ModelsTabView`, a pass-through that put `LlmManagementView`
 * inside a `CapabilityPageShell` while `LlmManagementView` built a second shell
 * of its own inside that. The coverage did not shrink with it: the shell, its
 * copy and its slots are all still pinned below, one file further down.
 */
describe('LlmTabStrip', () => {
  test('renders every tab in LLM_TABS, in order', () => {
    const out = renderToStaticMarkup(<LlmTabStrip value="providers" onValueChange={() => {}} />);
    const positions = LLM_TABS.map((t) => {
      expect(out).toContain(`>${t.label}<`);
      return out.indexOf(`>${t.label}<`);
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /**
   * The quick dialog renders THIS component with a `tabs` subset — three of the
   * same pills, in the same order, not three different ones. Anything the
   * dialog needs that this component cannot express is a divergence.
   */
  test('renders a subset when given one, in LLM_TABS order and style', () => {
    const out = renderToStaticMarkup(
      <LlmTabStrip value="models" tabs={QUICK_LLM_TABS} onValueChange={() => {}} />,
    );
    for (const t of QUICK_LLM_TABS) expect(out).toContain(`>${t.label}<`);
    // The four page-only tabs are absent, and nothing else changed: same
    // default pill list, no underline rule.
    for (const t of LLM_TABS.slice(3)) expect(out).not.toContain(`>${t.label}<`);
    expect(out.indexOf('>Models<')).toBeGreaterThan(out.indexOf('>Providers<'));
    expect(out.indexOf('>Custom<')).toBeGreaterThan(out.indexOf('>Models<'));
    const full = renderToStaticMarkup(<LlmTabStrip value="models" onValueChange={() => {}} />);
    // Identical trigger chrome — the class string a pill renders with.
    const triggerClass = (html: string) =>
      html.match(/data-slot="tabs-trigger"[^>]*class="([^"]+)"/)?.[1];
    expect(triggerClass(out)).toBe(triggerClass(full));
  });

  test('the selected tab is the one it is given', () => {
    const out = renderToStaticMarkup(<LlmTabStrip value="gateway" onValueChange={() => {}} />);
    const active = out.match(/data-state="active"[^>]*>([^<]+)</);
    expect(out).toContain('data-state="active"');
    expect(active?.[1] ?? out).toContain('Gateway');
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

const gatewaySource = code(uiSourcePath('customize/sections/gateway-view.tsx'));
const gatewayAccessSource = code(
  uiSourcePath('customize/sections/gateway-access-tab.tsx'),
);
const connectorsSource = code(
  uiSourcePath('customize/connectors/connectors-page.tsx'),
);
const overviewSource = code(
  uiSourcePath('customize/sections/view/gateway/gateway-overview.tsx'),
);
const routingSource = code(
  uiSourcePath('customize/sections/view/gateway/gateway-routing.tsx'),
);
const playgroundPath = '../../customize/sections/view/gateway/gateway-playground.tsx';
const deletedKeysTabPath = '../../customize/sections/llm-api-keys-tab.tsx';

/**
 * Page chrome. Models is a sibling tab of Connectors / Agents / Skills /
 * Triggers / Secrets on the Customize bar and has to read as one: same
 * `CapabilityPageShell`, same `max-w-5xl` column, same heading, same header
 * group, and — the thing Jay flagged — the same tab strip.
 *
 * Source-level assertions, following `schedule-view.test.tsx` and
 * `secrets-view.chrome.test.ts`: apps/web has no DOM testing library, and what
 * is pinned here is WHERE a control is mounted, not what it renders.
 */
describe('Models page chrome', () => {
  test('the page is the shared capability shell, not its own header strip', () => {
    expect(gatewaySource.indexOf('<CapabilityPageShell')).toBeGreaterThan(-1);
    expect(MODELS_PAGE_TITLE).toBe('Models');
    expect(MODELS_PAGE_DESCRIPTION).toBe('Choose the providers and models this project can use.');
    expect(gatewaySource).toContain('title={MODELS_PAGE_TITLE}');
    expect(gatewaySource).toContain('description={MODELS_PAGE_DESCRIPTION}');
    // Every piece of the old bespoke layout, gone for good.
    expect(gatewaySource).not.toContain('SettingsSectionHeader');
    expect(gatewaySource).not.toContain('SettingsTabHeader');
    expect(gatewaySource).not.toContain('CustomizeSectionWrapper');
  });

  test('the tab strip is the shell’s filters slot, in the DEFAULT pill style', () => {
    expect(gatewaySource).toContain('filters={');
    expect(gatewaySource).toContain('<LlmTabStrip');
    // The exact control Connectors draws: a bare `TabsList`, no `type`, no
    // `size`, no className. `type="underline"` is what made this page read as a
    // different product beside its five siblings.
    expect(gatewaySource).toContain('<TabsList>');
    expect(connectorsSource).toContain('<TabsList>');
    expect(gatewaySource).not.toContain('underline');
    expect(gatewaySource).not.toContain('<TabsList type=');
    expect(gatewaySource).not.toContain('<TabsList size=');
  });

  test('the project-default picker sits on the tab row, opposite the tabs', () => {
    const filtersStart = gatewaySource.indexOf('filters={');
    expect(filtersStart).toBeGreaterThan(-1);
    const filtersSlot = gatewaySource.slice(filtersStart, gatewaySource.indexOf('<LlmSections'));
    expect(filtersSlot).toContain('<LlmTabStrip');
    expect(filtersSlot).toContain('<ProjectDefaultPicker');
    expect(filtersSlot.indexOf('<LlmTabStrip')).toBeLessThan(filtersSlot.indexOf('<ProjectDefaultPicker'));
    // A secondary button, with no "Project default" label beside it.
    expect(gatewaySource).toContain('triggerVariant="secondary"');
  });


  /**
   * The one page-level control is one component, mounted twice: here in the
   * shell's `action` slot and in `ProjectProviderModal`'s header. A second
   * `<ModelSelector` in this file would mean the dialog and the page had
   * drifted apart again.
   */
  test('ProjectDefaultPicker is the only place this module builds the picker', () => {
    expect(gatewaySource.match(/<ModelSelector/g)).toHaveLength(1);
    const picker = gatewaySource.slice(
      gatewaySource.indexOf('export function ProjectDefaultPicker'),
      gatewaySource.indexOf('export function LlmSections'),
    );
    expect(picker).toContain('<ModelSelector');
    expect(picker).toContain('Project default');
  });

  /**
   * `LlmSections` is the page body AND the dialog body. It must stay padding-
   * free horizontally: the host column supplies it (`CapabilityPageShell`
   * here, `px-5` in the dialog), and a `px-*` added here double-indents the
   * page — which is the bug that made the model rows sit 20px right of the
   * heading in the first place.
   */
  test('LlmSections carries no column padding of its own', () => {
    const sections = gatewaySource.slice(
      gatewaySource.indexOf('export function LlmSections'),
      gatewaySource.indexOf('export function LlmManagementView'),
    );
    expect(sections).toContain("tab === 'models'");
    expect(sections).not.toMatch(/className="[^"]*\bpx-\d/);
    expect(sections).not.toMatch(/className="[^"]*\bp-[1-9]/);
    // The provider list opens providers into the host's sheet.
    expect(sections).toContain('onSelect={onSelectProvider}');
  });

  /**
   * The dialog's three tabs are a SLICE of the page's seven — same ids, same
   * labels, same order. A second hand-written list is how "API keys" vs
   * "Providers" happened.
   */
  test('QUICK_LLM_TABS is the first three of LLM_TABS, unchanged', () => {
    expect(QUICK_LLM_TABS).toEqual(LLM_TABS.slice(0, 3));
    expect(QUICK_LLM_TABS.map((t) => t.label)).toEqual(['Providers', 'Models', 'Custom']);
    for (const t of QUICK_LLM_TABS) {
      expect(LLM_TABS).toContainEqual(t);
    }
  });

  test('no sub-tab declares a column of its own — the shell’s max-w-5xl is the page', () => {
    // `CustomizeSectionWrapper` is the settings PANEL's shell: `max-w-2xl` and
    // its own scroller. Routing mounted it, so that one tab rendered 320px
    // narrower than the six beside it and off the column's left edge.
    for (const source of [gatewaySource, routingSource, overviewSource]) {
      expect(source).not.toContain('CustomizeSectionWrapper');
      expect(source).not.toMatch(/mx-auto w-full max-w-/);
    }
  });

  test('one scroll container: the shell’s. No panel opens a second.', () => {
    // `TabsContent` is gone entirely — six panels, each `min-h-0
    // overflow-y-auto`, nested inside a shell that already scrolls.
    expect(gatewaySource).not.toContain('TabsContent');
    expect(gatewaySource).not.toContain('overflow-y-auto');
    expect(gatewaySource).not.toContain('h-full');
  });
});

describe('Models page — the seven tabs', () => {
  test('the bar is Providers → Logs, in work order', () => {
    // Pinned as id+label PAIRS, not bare labels — a bare-label check could
    // pass against a comment or against the wrong tab.
    for (const pair of [
      "{ id: 'providers', label: 'Providers' }",
      "{ id: 'models', label: 'Models' }",
      "{ id: 'custom', label: 'Custom' }",
      "{ id: 'gateway', label: 'Gateway' }",
      "{ id: 'routing', label: 'Routing' }",
      "{ id: 'overview', label: 'Costs' }",
      "{ id: 'logs', label: 'Logs' }",
    ]) {
      expect(gatewaySource).toContain(pair);
    }
    expect(LLM_TABS.map((t) => t.id)).toEqual([
      'providers',
      'models',
      'custom',
      'gateway',
      'routing',
      'overview',
      'logs',
    ]);
    // "API keys" named a tab that held keys pointing in both directions. Two
    // tabs name their direction now, and neither reuses the old label.
    expect(LLM_TABS.map((t) => t.label)).not.toContain('API keys');
  });

  test('Providers is the provider list ALONE — the gateway key left', () => {
    const providersBranch = gatewaySource.slice(
      gatewaySource.indexOf("tab === 'providers'"),
      gatewaySource.indexOf("tab === 'models'"),
    );
    expect(providersBranch).toContain('<ProviderConnect');
    expect(providersBranch).not.toContain('GatewayKeys');
    expect(providersBranch).not.toContain('GatewayApiReference');
    // JAY-510's invariant: mounted directly, no dialog.
    expect(gatewaySource).not.toContain('ProjectProviderModal');
  });

  test('Gateway is how to call it, then the keys you hand out', () => {
    expect(gatewaySource).toContain('<GatewayAccessTab');
    const quickstart = gatewayAccessSource.indexOf('<GatewayQuickstartCode');
    const keys = gatewayAccessSource.indexOf('<GatewayKeys');
    expect(quickstart).toBeGreaterThan(-1);
    expect(keys).toBeGreaterThan(quickstart);
    // The full-reference disclosure is gone from the tab; the key-created
    // dialog still carries the first request.
    expect(gatewayAccessSource).not.toContain('<GatewayApiReference');
    // The three-in-one tab is gone, file and all.
    expect(existsSync(join(import.meta.dir, deletedKeysTabPath))).toBe(false);
    expect(gatewayAccessSource).not.toContain('ProviderConnect');
  });

  test('the merged-away and deleted tabs never come back as tabs', () => {
    // Playground deleted outright; `keys` + `api` are the Gateway tab now;
    // `budgets` is a section of Costs. None may return as a tab id.
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
    expect(gatewaySource).toContain("'llm-budgets': 'overview'");
    // Re-pointed with their content: both used to resolve to `providers`, which
    // is no longer where a gateway key or its reference lives.
    expect(gatewaySource).toContain("'llm-keys': 'gateway'");
    expect(gatewaySource).toContain("'llm-api': 'gateway'");
  });

  test('Costs carries the budget section that used to be its own tab', () => {
    expect(overviewSource).toContain('<GatewayBudgetSection');
    expect(gatewaySource).toContain(
      '<GatewayOverview projectId={projectId} canWrite={canWrite} />',
    );
  });

  test('the model-visibility list kept a home as a sibling sub-section', () => {
    expect(gatewaySource).toContain("{ id: 'models', label: 'Models' }");
    expect(gatewaySource).toContain('<ModelsTab projectId={projectId} canWrite={canWrite} />');
  });
});
