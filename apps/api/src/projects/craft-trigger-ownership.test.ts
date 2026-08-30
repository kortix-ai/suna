/**
 * `craft:` ownership must survive the trigger CRUD round trip.
 *
 * The CRUD path is read-modify-write on the WHOLE manifest entry:
 *
 *   manifest → parseTriggerEntry → spec → specToBody → body
 *            → parseTriggerDraft → draft → draftToSpec → spec
 *            → triggerSpecToTomlEntry → manifest
 *
 * Every hop has to carry `craft`. Drop it at any one of them and the first
 * time anyone toggles a craft-installed trigger in the UI, the trigger is
 * silently orphaned: it keeps firing, `project_trigger_runtime.craft_slug`
 * clears on the next reconcile, and the craft's run history stops — with no
 * error anywhere. These tests walk the full loop rather than each hop, because
 * the bug is in the composition.
 */
import { describe, expect, test } from 'bun:test';
import { draftToSpec, parseTriggerDraft, specToBody } from './lib/triggers';
import { type ParsedManifest, extractTriggers, triggerSpecToTomlEntry } from './triggers';

function manifest(triggers: unknown[]): ParsedManifest {
  return {
    schemaVersion: 2,
    raw: { kortix_version: 2, default_agent: 'kortix', agents: { kortix: {} }, triggers },
    format: 'yaml',
    path: 'kortix.yaml',
    revision: null,
  };
}

const CRAFT_TRIGGER = {
  slug: 'seo-weekly',
  name: 'Weekly SEO sweep',
  type: 'cron',
  craft: 'seo-watch',
  agent: 'kortix',
  enabled: false,
  cron: '0 0 9 * * 1',
  prompt: 'Audit the site and open a CR.',
};

/** One full CRUD round trip, as PATCH performs it. */
function roundTrip(entry: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  const current = extractTriggers(manifest([entry])).specs[0];
  expect(current).toBeDefined();
  const base = specToBody(current);
  const draft = parseTriggerDraft(
    { ...base, ...patch, slug: current.slug },
    {
      existingSlug: current.slug,
    },
  );
  if ('error' in draft) throw new Error(`draft failed: ${draft.error}`);
  const next = draftToSpec(draft, 'kortix.yaml');
  return { current, next, written: triggerSpecToTomlEntry(next) };
}

describe('craft ownership on a trigger', () => {
  test('the manifest `craft:` key is read onto the spec', () => {
    const { specs, errors } = extractTriggers(manifest([CRAFT_TRIGGER]));
    expect(errors).toEqual([]);
    expect(specs[0].craftSlug).toBe('seo-watch');
  });

  test('a hand-authored trigger has no owner', () => {
    const { craft, ...handAuthored } = CRAFT_TRIGGER;
    expect(extractTriggers(manifest([handAuthored])).specs[0].craftSlug).toBeNull();
  });

  test('a malformed craft ref degrades to null instead of failing the entry', () => {
    // The manifest gate rejects a non-slug ref; the runtime reader must still
    // return a firing trigger rather than taking it offline.
    const { specs, errors } = extractTriggers(
      manifest([{ ...CRAFT_TRIGGER, craft: 'Not A Slug' }]),
    );
    expect(errors).toEqual([]);
    expect(specs[0].slug).toBe('seo-weekly');
    expect(specs[0].craftSlug).toBeNull();
  });

  test('a PATCH that only toggles `enabled` PRESERVES the owner', () => {
    const { next, written } = roundTrip(CRAFT_TRIGGER, { enabled: true });
    expect(next.enabled).toBe(true);
    expect(next.craftSlug).toBe('seo-watch');
    expect(written.craft).toBe('seo-watch');
  });

  test('a PATCH that rewrites the schedule and prompt PRESERVES the owner', () => {
    const { next, written } = roundTrip(CRAFT_TRIGGER, {
      cron: '0 0 6 * * *',
      prompt_template: 'Different work',
    });
    expect(next.cron).toBe('0 0 6 * * *');
    expect(written.craft).toBe('seo-watch');
  });

  test('the written entry is byte-stable across a no-op round trip', () => {
    const { written } = roundTrip(CRAFT_TRIGGER);
    expect(written.craft).toBe('seo-watch');
    // Re-reading what we wrote yields the same owner — the loop is closed.
    expect(extractTriggers(manifest([written])).specs[0].craftSlug).toBe('seo-watch');
  });

  test('a hand-authored trigger never gains a `craft` key', () => {
    const { craft, ...handAuthored } = CRAFT_TRIGGER;
    const { next, written } = roundTrip(handAuthored, { enabled: true });
    expect(next.craftSlug).toBeNull();
    // Absent, not `craft: null` — a hand-authored manifest entry stays clean.
    expect('craft' in written).toBe(false);
  });

  test('a create carries no owner even if a caller sends one', () => {
    // Ownership is written by the install flow's manifest edit, never accepted
    // from an API caller — a client must not be able to attribute its trigger
    // to someone else's craft and inherit its run report.
    const draft = parseTriggerDraft(
      { slug: 'mine', name: 'Mine', type: 'cron', cron: '0 0 9 * * 1', prompt_template: 'go' },
      { existingSlug: null },
    );
    if ('error' in draft) throw new Error(draft.error);
    expect(draft.craftSlug).toBeNull();
    expect('craft' in triggerSpecToTomlEntry(draftToSpec(draft))).toBe(false);
  });
});
