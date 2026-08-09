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
});

describe('isRailItemActive', () => {
  test('an item matches its own tab', () => {
    expect(isRailItemActive(item('members'), 'members')).toBe(true);
    expect(isRailItemActive(item('members'), 'secrets')).toBe(false);
  });

  test('models stands in for every llm sub-tab', () => {
    expect(isRailItemActive(item('models'), 'models')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-logs')).toBe(true);
    expect(isRailItemActive(item('models'), 'llm-budgets')).toBe(true);
    expect(isRailItemActive(item('models'), 'members')).toBe(false);
  });
});
