import { describe, expect, test } from 'bun:test';
import type { CustomizeSection } from '@/lib/customize-sections';
import { type RailFlags, isRailItemActive, railGroups } from './rail';
import type { RailItem } from './type';

const item = (section: RailItem['section']): RailItem => ({ section, label: section });

const flags = (overrides: Partial<RailFlags> = {}): RailFlags => ({
  tunnelEnabled: false,
  marketplaceEnabled: false,
  llmGatewayAvailable: false,
  voiceEnabled: false,
  reviewEnabled: false,
  ...overrides,
});

const sectionsOf = (f: RailFlags): CustomizeSection[] =>
  railGroups(f).flatMap((g) => g.items.map((i) => i.section));

describe('isRailItemActive', () => {
  test('matches an item against its own section', () => {
    expect(isRailItemActive(item('agents'), 'agents')).toBe(true);
    expect(isRailItemActive(item('skills'), 'skills')).toBe(true);
    expect(isRailItemActive(item('commands'), 'commands')).toBe(true);
  });

  test('agents, skills, and commands are independent rail items with no shared activation', () => {
    expect(isRailItemActive(item('agents'), 'skills')).toBe(false);
    expect(isRailItemActive(item('agents'), 'commands')).toBe(false);
    expect(isRailItemActive(item('skills'), 'agents')).toBe(false);
    expect(isRailItemActive(item('skills'), 'commands')).toBe(false);
    expect(isRailItemActive(item('commands'), 'agents')).toBe(false);
    expect(isRailItemActive(item('commands'), 'skills')).toBe(false);
  });

  test('the llm-management item stands in for every llm-* sub-section', () => {
    expect(isRailItemActive(item('llm-management'), 'llm-management')).toBe(true);
    expect(isRailItemActive(item('llm-management'), 'llm-overview')).toBe(true);
    expect(isRailItemActive(item('llm-management'), 'llm-providers')).toBe(true);
    expect(isRailItemActive(item('llm-management'), 'llm-logs')).toBe(true);
  });

  test('the llm-management item is not active for a non-llm section', () => {
    expect(isRailItemActive(item('llm-management'), 'agents')).toBe(false);
    expect(isRailItemActive(item('llm-management'), 'git')).toBe(false);
  });

  test('a plain item does not match a different section', () => {
    expect(isRailItemActive(item('secrets'), 'connectors')).toBe(false);
    expect(isRailItemActive(item('git'), 'sandbox')).toBe(false);
  });
});

describe('railGroups', () => {
  test('the base rail carries no flag-gated item', () => {
    const sections = sectionsOf(flags());
    for (const gated of [
      'marketplace',
      'review',
      'voice',
      'computers',
      'llm-management',
    ] as const) {
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

  test('every Connect flag adds its own item independently', () => {
    const sections = sectionsOf(
      flags({ voiceEnabled: true, tunnelEnabled: true, llmGatewayAvailable: true }),
    );
    expect(sections).toContain('voice');
    expect(sections).toContain('computers');
    expect(sections).toContain('llm-management');
  });

  test('turning every flag on keeps the rail free of duplicates', () => {
    const sections = sectionsOf(
      flags({
        reviewEnabled: true,
        marketplaceEnabled: true,
        voiceEnabled: true,
        tunnelEnabled: true,
        llmGatewayAvailable: true,
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
