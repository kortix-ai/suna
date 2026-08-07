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

  // Empirically verified against the real TanStack engine (see query-contracts.ts's
  // doc comment): with refetchOnMount:false, invalidateQueries's default
  // refetchType:'active' does nothing for an entry with no mounted observer, so
  // an invalidated-but-unobserved entry serves its stale (or wrongly-optimistic)
  // value for the rest of gcTime. refetchOnMount:true self-heals on the very next
  // mount, and — because it still respects staleTime — costs zero extra fetches
  // when the entry is fresh.
  test('every tier refetches on mount, so an invalidated-but-unobserved entry self-heals', () => {
    for (const tier of TIERS) {
      expect(contract(tier).refetchOnMount).toBe(true);
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

  // Both started on `volatile` (5s) purely because "sandbox" and "gateway"
  // SOUND time-sensitive. Neither is. Pinned here so a revert to `volatile`
  // fails a test instead of quietly multiplying refetches on every project
  // landing and every Customize -> Gateway open. Reasoning in the tier table.
  test('sandboxes is the template catalog, not live health — config tier', () => {
    // `listProjectSandboxes` and `listProjectSandboxTemplates` are the same
    // GET /projects/:id/sandboxes returning the same SandboxTemplatesResponse.
    // Two keys, so they must at least agree on freshness.
    expect(FRESHNESS.sandboxes).toBe('config');
    expect(FRESHNESS.sandboxTemplates).toBe(FRESHNESS.sandboxes);
  });

  test('gateway analytics accumulate from traffic, not from our mutations — inventory tier', () => {
    expect(FRESHNESS.gateway).toBe('inventory');
  });

  // `volatile` has no claimant today. Kept because `FreshnessTier` is a
  // published string-literal union and removing a member is breaking — but a
  // future entity has to earn it against this bar, not inherit it by vibe.
  test('volatile is still the sharpest tier, for whatever earns it next', () => {
    expect(contract('volatile').staleTime).toBe(5_000);
    const claimants = Object.entries(FRESHNESS).filter(([, tier]) => tier === 'volatile');
    expect(claimants).toEqual([]);
  });
});
