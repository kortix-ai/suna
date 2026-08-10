import { describe, expect, test } from 'bun:test';
import { type RailFlags, isRailItemActive, railGroups } from './rail';
import type { RailItem } from './type';

const item = (section: RailItem['section']): RailItem => ({ section, label: section });

const flags = (overrides: Partial<RailFlags> = {}): RailFlags => ({
  marketplaceEnabled: false,
  llmGatewayEnabled: false,
  voiceEnabled: false,
  reviewEnabled: false,
  ...overrides,
});

const sectionsOf = (f: RailFlags): string[] =>
  railGroups(f).flatMap((g) => g.items.map((i) => i.section));

describe('isRailItemActive', () => {
  test('matches an item against its own section', () => {
    expect(isRailItemActive(item('channels'), 'channels')).toBe(true);
    expect(isRailItemActive(item('secrets'), 'secrets')).toBe(true);
    expect(isRailItemActive(item('git'), 'git')).toBe(true);
  });

  test('plain items are independent rail items with no shared activation', () => {
    expect(isRailItemActive(item('channels'), 'secrets')).toBe(false);
    expect(isRailItemActive(item('channels'), 'git')).toBe(false);
    expect(isRailItemActive(item('secrets'), 'channels')).toBe(false);
    expect(isRailItemActive(item('secrets'), 'git')).toBe(false);
    expect(isRailItemActive(item('git'), 'channels')).toBe(false);
    expect(isRailItemActive(item('git'), 'secrets')).toBe(false);
  });

  test('the llm-management item stands in for every llm-* sub-section', () => {
    expect(isRailItemActive(item('llm-management'), 'llm-management')).toBe(true);
    expect(isRailItemActive(item('llm-management'), 'llm-overview')).toBe(true);
    expect(isRailItemActive(item('llm-management'), 'llm-providers')).toBe(true);
    expect(isRailItemActive(item('llm-management'), 'llm-logs')).toBe(true);
  });

  test('the llm-management item is not active for a non-llm section', () => {
    expect(isRailItemActive(item('llm-management'), 'channels')).toBe(false);
    expect(isRailItemActive(item('llm-management'), 'git')).toBe(false);
  });

  test('a plain item does not match a different section', () => {
    expect(isRailItemActive(item('secrets'), 'channels')).toBe(false);
    expect(isRailItemActive(item('git'), 'sandbox')).toBe(false);
  });
});

describe('railGroups', () => {
  test('uses Secrets as the user-facing section name', () => {
    const secrets = railGroups(flags())
      .flatMap((group) => group.items)
      .find((railItem) => railItem.section === 'secrets');

    expect(secrets?.label).toBe('Secrets');
  });

  test('the base rail carries no flag-gated item', () => {
    const sections = sectionsOf(flags());
    for (const gated of ['marketplace', 'review', 'voice', 'llm-management'] as const) {
      expect(sections).not.toContain(gated);
    }
  });

  test('Review is in the rail whenever the flag is on — even with Marketplace on', () => {
    // Marketplace defaults ON for every project, so this is the ONLY combination
    // that matters in practice: an early return on the first matching Build flag
    // used to drop Review, which made the sidebar "Review" pill open Customize on
    // the default section instead of the inbox.
    expect(sectionsOf(flags({ reviewEnabled: true }))).toContain('review');
    expect(sectionsOf(flags({ reviewEnabled: true, marketplaceEnabled: true }))).toContain(
      'review',
    );
  });

  test('Marketplace survives Review being on', () => {
    expect(sectionsOf(flags({ reviewEnabled: true, marketplaceEnabled: true }))).toContain(
      'marketplace',
    );
  });

  test('every remaining Connect flag adds its own item independently', () => {
    const sections = sectionsOf(flags({ voiceEnabled: true, llmGatewayEnabled: true }));
    expect(sections).toContain('voice');
    expect(sections).toContain('llm-management');
    expect(sections).not.toContain('computers');
  });

  test('turning every flag on keeps the rail free of duplicates', () => {
    const sections = sectionsOf(
      flags({
        reviewEnabled: true,
        marketplaceEnabled: true,
        voiceEnabled: true,
        llmGatewayEnabled: true,
      }),
    );
    expect(new Set(sections).size).toBe(sections.length);
  });

  test('a section reachable in the rail is the one the panel can activate', () => {
    // The panel bounces to the default section when no rail item matches, so a
    // gated section MUST resolve through isRailItemActive to be reachable.
    const items = railGroups(flags({ reviewEnabled: true })).flatMap((g) => g.items);
    expect(items.some((i) => isRailItemActive(i, 'review'))).toBe(true);
  });
});

describe('capability sections', () => {
  test('the rail excludes standalone agents, connectors and skills pages', () => {
    const sections = sectionsOf(
      flags({
        marketplaceEnabled: true,
        llmGatewayEnabled: true,
        voiceEnabled: true,
        reviewEnabled: true,
      }),
    );
    // Agents moved to /projects/<id>/agent. A rail item here would open an
    // overlay section customize-panel no longer has a case for — a blank pane.
    expect(sections).not.toContain('agents');
    expect(sections).not.toContain('agent');
    expect(sections).not.toContain('connectors');
    expect(sections).not.toContain('skills');
  });

  test('the rail offers commands because its standalone page was removed', () => {
    expect(sectionsOf(flags())).toContain('commands');
  });

  test('the sections that stay are untouched', () => {
    const sections = sectionsOf(flags());
    expect(sections).toContain('secrets');
    expect(sections).toContain('channels');
    expect(sections).toContain('members');
  });

  test('the Build group keeps Commands when every flagged item is off', () => {
    // Agents was Build's only static item until it graduated; Commands took
    // that slot when #6169 deleted its standalone page. So the group no longer
    // empties out. customize-panel still filters empty groups — that guard
    // simply has nothing to catch in Build today.
    const groups = railGroups(flags({ marketplaceEnabled: false, reviewEnabled: false }));
    expect(groups.find((g) => g.label === 'Build')?.items.map((i) => i.section)).toEqual([
      'commands',
    ]);
  });

  test('the Build group appends Marketplace and Review when enabled', () => {
    const build = railGroups(flags({ marketplaceEnabled: true, reviewEnabled: true })).find(
      (g) => g.label === 'Build',
    );
    expect(build?.items.map((i) => i.section)).toEqual(['commands', 'marketplace', 'review']);
  });
});
