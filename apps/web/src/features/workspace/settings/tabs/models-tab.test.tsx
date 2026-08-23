import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LLM_TABS,
  LlmTabStrip,
  MODELS_PAGE_DESCRIPTION,
  MODELS_PAGE_TITLE,
  QUICK_LLM_TABS,
} from '../../customize/sections/gateway-view';

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
    for (const t of LLM_TABS.slice(2)) expect(out).not.toContain(`>${t.label}<`);
    expect(out.indexOf('>Models<')).toBeGreaterThan(out.indexOf('>Providers<'));
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

const tabSource = code(join(import.meta.dir, 'models-tab.tsx'));
const gatewaySource = code(join(import.meta.dir, '../../customize/sections/gateway-view.tsx'));
const gatewayAccessSource = code(
  join(import.meta.dir, '../../customize/sections/gateway-access-tab.tsx'),
);
const connectorsSource = code(
  join(import.meta.dir, '../../capabilities/connectors/connectors-page.tsx'),
);
const overviewSource = code(
  join(import.meta.dir, '../../customize/sections/view/gateway/gateway-overview.tsx'),
);
const routingSource = code(
  join(import.meta.dir, '../../customize/sections/view/gateway/gateway-routing.tsx'),
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
    expect(MODELS_PAGE_DESCRIPTION).toBe('Which providers and models this project can use.');
    expect(gatewaySource).toContain('title={MODELS_PAGE_TITLE}');
    expect(gatewaySource).toContain('description={MODELS_PAGE_DESCRIPTION}');
    // Every piece of the old bespoke layout, gone for good.
    expect(gatewaySource).not.toContain('SettingsSectionHeader');
    expect(gatewaySource).not.toContain('SettingsTabHeader');
    expect(gatewaySource).not.toContain('CustomizeSectionWrapper');
    expect(tabSource).not.toContain('CapabilityPageShell');
    expect(tabSource).not.toContain('gatewaySlot');
  });

  test('the tab strip is the shell’s filters slot, in the DEFAULT pill style', () => {
    expect(gatewaySource).toContain('filters={<LlmTabStrip');
    // The exact control Connectors draws: a bare `TabsList`, no `type`, no
    // `size`, no className. `type="underline"` is what made this page read as a
    // different product beside its five siblings.
    expect(gatewaySource).toContain('<TabsList>');
    expect(connectorsSource).toContain('<TabsList>');
    expect(gatewaySource).not.toContain('underline');
    expect(gatewaySource).not.toContain('<TabsList type=');
    expect(gatewaySource).not.toContain('<TabsList size=');
  });

  test('the project-default picker is the shell’s action slot, not a second strip', () => {
    const actionStart = gatewaySource.indexOf('action={');
    const filtersStart = gatewaySource.indexOf('filters={');
    expect(actionStart).toBeGreaterThan(-1);
    expect(filtersStart).toBeGreaterThan(actionStart);
    // The picker sits in `action` — not in the tab row, where a bordered
    // dropdown reads as a second tab strip. It is a component now
    // (`ProjectDefaultPicker`) because the quick dialog renders the same one;
    // `<ModelSelector` itself lives inside it, higher up the file, so this
    // asserts the SLOT's contents, not a raw file offset.
    expect(gatewaySource.slice(actionStart, filtersStart)).toContain('<ProjectDefaultPicker');
    const filtersSlot = gatewaySource.slice(filtersStart, gatewaySource.indexOf('<LlmSections'));
    expect(filtersSlot).toContain('<LlmTabStrip');
    expect(filtersSlot).not.toContain('ProjectDefaultPicker');
    expect(filtersSlot).not.toContain('ModelSelector');
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
    // `ProviderConnect` is the one section with padding of its own to cancel.
    expect(sections).toContain("className=\"gap-4 p-0\"");
  });

  /**
   * The dialog's two tabs are a SLICE of the page's six — same ids, same
   * labels, same order. A second hand-written list is how "API keys" vs
   * "Providers" happened.
   */
  test('QUICK_LLM_TABS is the first two of LLM_TABS, unchanged', () => {
    expect(QUICK_LLM_TABS).toEqual(LLM_TABS.slice(0, 2));
    expect(QUICK_LLM_TABS.map((t) => t.label)).toEqual(['Providers', 'Models']);
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

describe('Models tab — no gate', () => {
  test('Models is always on: gateway mode is the only mode, so the tab has no flag to read', () => {
    // The retired `llm_gateway` flag used to hide the whole pane. There is no
    // second mode any more, so there is nothing to gate on — not the flag, not
    // an availability bit, not a re-derivation.
    expect(tabSource).not.toContain('llmGatewayEnabled');
    expect(tabSource).not.toContain('isLlmGatewayEnabled(');
    expect(tabSource).not.toContain('llmGatewayAvailable');
    expect(tabSource).toContain('<LlmManagementView projectId={projectId} />');
  });
});

describe('Models page — the seven tabs', () => {
  test('the bar is Providers → Logs, in work order', () => {
    // Pinned as id+label PAIRS, not bare labels — a bare-label check could
    // pass against a comment or against the wrong tab.
    for (const pair of [
      "{ id: 'providers', label: 'Providers' }",
      "{ id: 'models', label: 'Models' }",
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

  test('Gateway is the key you hand out AND how to call it, in that order', () => {
    expect(gatewaySource).toContain('<GatewayAccessTab');
    const keys = gatewayAccessSource.indexOf('<GatewayKeys');
    const reference = gatewayAccessSource.indexOf('<GatewayApiReference');
    expect(keys).toBeGreaterThan(-1);
    expect(reference).toBeGreaterThan(keys);
    // The three-in-one tab is gone, file and all.
    expect(existsSync(join(import.meta.dir, deletedKeysTabPath))).toBe(false);
    expect(gatewayAccessSource).not.toContain('ProviderConnect');
  });

  test('the merged-away and deleted tabs never come back as tabs', () => {
    // Playground deleted outright; `keys` + `api` are the Gateway tab now;
    // `budgets` is a section of Costs. None may return as a tab id.
    // `custom` generated an OpenCode `provider:{...}` block for
    // `.opencode/opencode.jsonc` — an OpenCode-native provider, which no
    // session can use: OpenCode sees exactly one provider, `kortix`.
    for (const dead of [
      "id: 'playground'",
      "id: 'budgets'",
      "id: 'keys'",
      "id: 'api'",
      "id: 'custom'",
      'GatewayPlayground',
      'CustomProviderPanel',
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
    expect(gatewaySource).toContain('<GatewayOverview projectId={projectId} canWrite={canWrite} />');
  });

  test('the model-visibility list kept a home as a sibling sub-section', () => {
    expect(gatewaySource).toContain("{ id: 'models', label: 'Models' }");
    expect(gatewaySource).toContain('<ModelsTab projectId={projectId} />');
  });
});
