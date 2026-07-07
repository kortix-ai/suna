import { describe, expect, test } from 'bun:test';
import { isRailItemActive } from './rail';
import type { RailItem } from './type';

const item = (section: RailItem['section']): RailItem => ({ section, label: section });

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
    expect(isRailItemActive(item('llm-management'), 'files')).toBe(false);
  });

  test('a plain item does not match a different section', () => {
    expect(isRailItemActive(item('secrets'), 'connectors')).toBe(false);
    expect(isRailItemActive(item('files'), 'sandbox')).toBe(false);
  });
});
