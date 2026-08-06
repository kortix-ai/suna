import { describe, expect, test } from 'bun:test';
import { FRESHNESS, contract, type FreshnessTier } from './query-contracts';

const TIERS: FreshnessTier[] = ['live', 'config', 'inventory', 'volatile'];

describe('freshness contracts', () => {
  // The whole point of a tier is that a call site cannot disagree with it.
  // If gcTime ever falls to or below staleTime the tier reproduces the exact
  // provider-level bug this work exists to remove.
  test('every tier keeps data alive longer than it keeps it fresh', () => {
    for (const tier of TIERS) {
      const c = contract(tier);
      if (c.staleTime === Infinity) continue;
      expect(c.gcTime).toBeGreaterThan(c.staleTime);
    }
  });

  test('the live tier never expires on its own', () => {
    expect(contract('live').staleTime).toBe(Infinity);
  });

  test('no tier refetches on mount', () => {
    for (const tier of TIERS) {
      expect(contract(tier).refetchOnMount).toBe(false);
    }
  });

  test('tiers are ordered from most to least fresh', () => {
    expect(contract('volatile').staleTime).toBeLessThan(contract('inventory').staleTime);
    expect(contract('inventory').staleTime).toBeLessThan(contract('config').staleTime);
    expect(contract('config').staleTime).toBeLessThan(contract('live').staleTime);
  });

  test('every declared entity resolves to exactly one tier', () => {
    const entities = Object.keys(FRESHNESS);
    expect(entities.length).toBeGreaterThan(0);
    for (const entity of entities) {
      expect(TIERS).toContain(FRESHNESS[entity as keyof typeof FRESHNESS]);
    }
  });

  test('project detail is config tier, sessions list is inventory', () => {
    expect(FRESHNESS.projectDetail).toBe('config');
    expect(FRESHNESS.sessions).toBe('inventory');
    expect(FRESHNESS.messages).toBe('live');
  });
});
