/**
 * The static catalog is the whole marketplace, so its invariants are the
 * product's: one slug per card, a real pinned commit, a manifest the install
 * prompt can embed, and a search that finds what a person would type.
 */
import { describe, expect, test } from 'bun:test';
import {
  MARKETPLACE_CATALOG,
  findMarketplaceCatalogEntry,
  getMarketplaceTemplate,
  listMarketplaceTemplates,
} from './templates';

describe('MARKETPLACE_CATALOG', () => {
  test('has at least one template and no duplicate slug', () => {
    expect(MARKETPLACE_CATALOG.length).toBeGreaterThan(0);
    const slugs = MARKETPLACE_CATALOG.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('every entry points at a real commit of a real repo, and declares a manifest', () => {
    for (const entry of MARKETPLACE_CATALOG) {
      expect(entry.slug).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/);
      expect(entry.repo).toBe(`${entry.repo_owner}/${entry.repo_name}`);
      // The install prompt reads files at this sha; a branch name here would
      // let the agent copy files that never matched the card.
      expect(entry.resolved_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.manifest.kortix_version).toBe(2);
      // The card's counts come from the manifest; a card that advertises an
      // agent the manifest does not declare would install nothing.
      for (const agent of entry.agents) {
        expect(Object.keys(entry.manifest.agents as Record<string, unknown>)).toContain(agent.name);
      }
    }
  });
});

describe('listMarketplaceTemplates', () => {
  test('returns cards WITHOUT the manifest', () => {
    const cards = listMarketplaceTemplates();
    expect(cards.length).toBe(MARKETPLACE_CATALOG.length);
    for (const card of cards) expect('manifest' in card).toBe(false);
  });

  test('searches title, description, repo and slug, case-insensitively', () => {
    const first = MARKETPLACE_CATALOG[0];
    expect(listMarketplaceTemplates(first.title.toUpperCase()).map((c) => c.slug)).toContain(
      first.slug,
    );
    expect(listMarketplaceTemplates(first.repo_name).map((c) => c.slug)).toContain(first.slug);
    expect(listMarketplaceTemplates(`  ${first.slug}  `).map((c) => c.slug)).toContain(
      first.slug,
    );
  });

  test('an empty or blank query is the whole catalog; a miss is an empty list', () => {
    expect(listMarketplaceTemplates('   ').length).toBe(MARKETPLACE_CATALOG.length);
    expect(listMarketplaceTemplates(null).length).toBe(MARKETPLACE_CATALOG.length);
    expect(listMarketplaceTemplates('no-such-template-zzz')).toEqual([]);
  });
});

describe('getMarketplaceTemplate / findMarketplaceCatalogEntry', () => {
  test('the card by slug carries no manifest; the entry does', () => {
    const slug = MARKETPLACE_CATALOG[0].slug;
    const card = getMarketplaceTemplate(slug);
    expect(card?.slug).toBe(slug);
    expect(card && 'manifest' in card).toBe(false);
    expect(findMarketplaceCatalogEntry(slug)?.manifest.kortix_version).toBe(2);
  });

  test('an unknown slug is null, never a throw', () => {
    expect(getMarketplaceTemplate('nope')).toBeNull();
    expect(findMarketplaceCatalogEntry('nope')).toBeNull();
  });
});
