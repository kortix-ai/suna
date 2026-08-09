import { describe, expect, test } from 'bun:test';
import { type RailFlags, isRailItemActive, railGroups } from './rail';
import type { RailItem } from './type';

const item = (tab: RailItem['tab']): RailItem => ({ tab, label: tab });

const flags = (overrides: Partial<RailFlags> = {}): RailFlags => ({
  tunnelEnabled: false,
  marketplaceEnabled: false,
  llmGatewayAvailable: false,
  voiceEnabled: false,
  reviewEnabled: false,
  ...overrides,
});

const tabsOf = (f: RailFlags): string[] => railGroups(f).flatMap((g) => g.items.map((i) => i.tab));

describe('railGroups', () => {
  test('renders the five groups in order', () => {
    expect(railGroups(flags()).map((g) => g.label)).toEqual([
      'You', 'Workspace', 'Agent', 'Organization', 'Developer',
    ]);
  });

  test('with every flag off it holds the static tabs only', () => {
    const tabs = tabsOf(flags());
    expect(tabs).toContain('profile');
    expect(tabs).toContain('channels');
    expect(tabs).toContain('billing');
    expect(tabs).not.toContain('computers');
    expect(tabs).not.toContain('voice');
    expect(tabs).not.toContain('review');
    expect(tabs).not.toContain('marketplace');
  });

  test('each flag adds exactly its own tab', () => {
    expect(tabsOf(flags({ tunnelEnabled: true }))).toContain('computers');
    expect(tabsOf(flags({ voiceEnabled: true }))).toContain('voice');
    expect(tabsOf(flags({ reviewEnabled: true }))).toContain('review');
    expect(tabsOf(flags({ marketplaceEnabled: true }))).toContain('marketplace');
  });

  test('two flags in one group both land — the rail.ts:110 regression', () => {
    const tabs = tabsOf(flags({ marketplaceEnabled: true, reviewEnabled: true, voiceEnabled: true }));
    expect(tabs).toContain('marketplace');
    expect(tabs).toContain('review');
    expect(tabs).toContain('voice');
  });

  test('every flag on yields 26 content tabs', () => {
    const all = flags({
      tunnelEnabled: true, marketplaceEnabled: true,
      llmGatewayAvailable: true, voiceEnabled: true, reviewEnabled: true,
    });
    expect(tabsOf(all)).toHaveLength(26);
  });

  test('no tab appears in two groups', () => {
    const tabs = tabsOf(flags({ tunnelEnabled: true, marketplaceEnabled: true, voiceEnabled: true, reviewEnabled: true }));
    expect(new Set(tabs).size).toBe(tabs.length);
  });

  test('upgrades is not in the scrolling groups — it is pinned', () => {
    expect(tabsOf(flags())).not.toContain('upgrades');
  });

  // Ported from the legacy Customize overlay's rail test + IA checkpoints test, which
  // covered this same rail before the settings-panel cutover deleted the
  // legacy Customize overlay and its own rail module.
  test('uses Secrets as the user-facing tab name', () => {
    const secrets = railGroups(flags())
      .flatMap((group) => group.items)
      .find((railItem) => railItem.tab === 'secrets');
    expect(secrets?.label).toBe('Secrets');
  });

  test('repositories (renamed from git) and sandbox templates are reachable, with no dead changes/dev tab', () => {
    const tabs = tabsOf(flags());
    expect(tabs).toContain('repositories');
    expect(tabs).toContain('sandbox');
    const sandbox = railGroups(flags())
      .flatMap((g) => g.items)
      .find((i) => i.tab === 'sandbox');
    expect(sandbox?.label).toBe('Sandbox templates');
    expect(tabs).not.toContain('changes');
    expect(tabs).not.toContain('dev');
  });

  test('the rail excludes standalone agent, connectors and skills pages', () => {
    const tabs = tabsOf(
      flags({
        tunnelEnabled: true,
        marketplaceEnabled: true,
        llmGatewayAvailable: true,
        voiceEnabled: true,
        reviewEnabled: true,
      }),
    );
    // Agent, Connectors and Skills graduated to their own routed pages — a
    // rail tab here would open a settings pane that has no case for them.
    expect(tabs).not.toContain('agent');
    expect(tabs).not.toContain('agents');
    expect(tabs).not.toContain('connectors');
    expect(tabs).not.toContain('skills');
  });

  test('the sections that stayed from Customize are untouched', () => {
    const tabs = tabsOf(flags());
    expect(tabs).toContain('secrets');
    expect(tabs).toContain('channels');
    expect(tabs).toContain('members');
  });

  test('instructions (renamed from commands) is reachable with every flag off — its standalone page was removed', () => {
    expect(tabsOf(flags())).toContain('instructions');
  });

  test('models is reachable in the rail regardless of the llm gateway flag — unlike the legacy llm-management row, it is not flag-gated', () => {
    expect(tabsOf(flags())).toContain('models');
    expect(tabsOf(flags({ llmGatewayAvailable: true }))).toContain('models');
  });

  test('a tab reachable in the rail is the one the panel can activate', () => {
    // The panel bounces to the default tab when no rail item matches, so a
    // gated tab MUST resolve through isRailItemActive to be reachable.
    const items = railGroups(flags({ reviewEnabled: true })).flatMap((g) => g.items);
    expect(items.some((i) => isRailItemActive(i, 'review'))).toBe(true);
  });
});

describe('isRailItemActive', () => {
  test('an item matches its own tab', () => {
    expect(isRailItemActive(item('members'), 'members')).toBe(true);
    expect(isRailItemActive(item('members'), 'secrets')).toBe(false);
  });

  test('plain items are independent rail items with no shared activation', () => {
    expect(isRailItemActive(item('channels'), 'secrets')).toBe(false);
    expect(isRailItemActive(item('channels'), 'repositories')).toBe(false);
    expect(isRailItemActive(item('secrets'), 'channels')).toBe(false);
    expect(isRailItemActive(item('secrets'), 'repositories')).toBe(false);
    expect(isRailItemActive(item('repositories'), 'channels')).toBe(false);
    expect(isRailItemActive(item('repositories'), 'secrets')).toBe(false);
  });

  test('models stands in for every llm sub-tab', () => {
    expect(isRailItemActive(item('models'), 'models')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-logs')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-budgets')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-management')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-providers')).toBe(true);
    expect(isRailItemActive(item('models'), 'members')).toBe(false);
  });

  test('the models item is not active for a non-llm tab', () => {
    expect(isRailItemActive(item('models'), 'channels')).toBe(false);
    expect(isRailItemActive(item('models'), 'repositories')).toBe(false);
  });
});
