/**
 * `extractCrafts` — the read side of the manifest `crafts:` block.
 *
 * The contract that matters: never throw, and never let one broken entry take
 * the healthy ones offline. A craft's whole purpose is that its triggers keep
 * firing, so a parse failure has to be reportable, not fatal.
 */
import { describe, expect, test } from 'bun:test';
import { craftTriggerActivation, extractCrafts, setCraftTriggersEnabled } from './crafts';
import type { ParsedManifest } from './triggers';

function manifest(raw: Record<string, unknown>, format: 'yaml' | 'toml' = 'yaml'): ParsedManifest {
  return { schemaVersion: 2, raw, format, path: 'kortix.yaml', revision: null };
}

const FULL = {
  slug: 'seo-watch',
  repo: 'acme/seo-craft',
  ref: 'main',
  sha: '9f3c1a7ecb4d21f0a8b3c5d7e9f1a2b3c4d5e6f7',
  version: 'v1.2.0',
  title: 'SEO watch',
  installed_at: '2026-08-30T09:14:02Z',
  owns: {
    agents: ['seo-writer'],
    skills: ['seo-audit'],
    connectors: ['search-console'],
    triggers: ['seo-weekly'],
  },
};

describe('extractCrafts', () => {
  test('an absent section is zero crafts, not an error', () => {
    expect(extractCrafts(manifest({}))).toEqual({ specs: [], errors: [] });
    expect(extractCrafts(manifest({ crafts: null }))).toEqual({ specs: [], errors: [] });
  });

  test('a full entry parses every field, splitting ref (asked for) from sha (resolved)', () => {
    const { specs, errors } = extractCrafts(manifest({ crafts: [FULL] }));
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual({
      slug: 'seo-watch',
      path: 'kortix.yaml#crafts.seo-watch',
      repoOwner: 'acme',
      repoName: 'seo-craft',
      gitRef: 'main',
      resolvedSha: '9f3c1a7ecb4d21f0a8b3c5d7e9f1a2b3c4d5e6f7',
      version: 'v1.2.0',
      title: 'SEO watch',
      installedAt: '2026-08-30T09:14:02Z',
      owns: {
        agents: ['seo-writer'],
        skills: ['seo-audit'],
        connectors: ['search-console'],
        triggers: ['seo-weekly'],
      },
    });
  });

  test('slug and repo are the only required fields; title defaults to the slug', () => {
    const { specs, errors } = extractCrafts(
      manifest({ crafts: [{ slug: 'standup', repo: 'kortix-ai/standup' }] }),
    );
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      slug: 'standup',
      title: 'standup',
      gitRef: null,
      resolvedSha: null,
      version: null,
      installedAt: null,
      owns: {},
    });
  });

  test('a broken entry is reported and the healthy ones still parse', () => {
    const { specs, errors } = extractCrafts(
      manifest({
        crafts: [
          { slug: 'good', repo: 'a/one' },
          { slug: 'no-repo' },
          { repo: 'a/three' },
          { slug: 'Bad Slug', repo: 'a/four' },
          { slug: 'bad-repo', repo: 'not-a-repo' },
          'not-a-table',
          { slug: 'also-good', repo: 'a/six' },
        ],
      }),
    );
    expect(specs.map((s) => s.slug)).toEqual(['good', 'also-good']);
    expect(errors).toHaveLength(5);
    expect(errors.find((e) => e.slug === 'no-repo')?.error).toContain('repo is required');
    expect(errors.find((e) => e.slug === 'bad-repo')?.error).toContain('owner/repo');
    expect(errors.find((e) => e.slug === 'Bad Slug')?.error).toContain('Invalid slug');
    expect(errors.every((e) => e.path === 'kortix.yaml')).toBe(true);
  });

  test('a duplicate slug is rejected, and the FIRST entry wins', () => {
    const { specs, errors } = extractCrafts(
      manifest({
        crafts: [
          { slug: 'standup', repo: 'first/one' },
          { slug: 'standup', repo: 'second/two' },
        ],
      }),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].repoOwner).toBe('first');
    expect(errors[0].error).toContain('Duplicate craft slug');
  });

  test('a non-list section reports once, with format-specific wording', () => {
    const yaml = extractCrafts(manifest({ crafts: { standup: {} } }, 'yaml'));
    expect(yaml.specs).toEqual([]);
    expect(yaml.errors).toHaveLength(1);
    expect(yaml.errors[0].error).toContain('YAML `crafts:` list');

    const toml = extractCrafts(manifest({ crafts: 'nope' }, 'toml'));
    expect(toml.errors[0].error).toContain('[[crafts]]');
  });

  test('owns drops unknown kinds and non-slug names, then dedupes and sorts', () => {
    const { specs } = extractCrafts(
      manifest({
        crafts: [
          {
            slug: 'c',
            repo: 'a/b',
            owns: {
              triggers: ['zed', 'alpha', 'zed', 'Not A Slug', '', 42],
              secrets: ['SLACK_TOKEN'],
              agents: [],
            },
          },
        ],
      }),
    );
    // Sorted + deduped, invalid names dropped.
    expect(specs[0].owns.triggers).toEqual(['alpha', 'zed']);
    // An unknown kind never lands in the map — uninstall must not act on it.
    expect(specs[0].owns).not.toHaveProperty('secrets');
    // An empty list is omitted rather than stored as [].
    expect(specs[0].owns).not.toHaveProperty('agents');
  });

  test('an empty-string field reads as absent rather than empty', () => {
    const { specs } = extractCrafts(
      manifest({ crafts: [{ slug: 'c', repo: 'a/b', ref: '   ', sha: '', title: '' }] }),
    );
    expect(specs[0].gitRef).toBeNull();
    expect(specs[0].resolvedSha).toBeNull();
    expect(specs[0].title).toBe('c');
  });

  test('the path breadcrumb follows the manifest file actually read', () => {
    const m = manifest({ crafts: [{ slug: 'c', repo: 'a/b' }] }, 'toml');
    m.path = 'kortix.toml';
    expect(extractCrafts(m).specs[0].path).toBe('kortix.toml#crafts.c');
  });
});

/**
 * `setCraftTriggersEnabled` — what actually starts a craft working.
 *
 * A craft installs with every trigger `enabled: false`, so this transform is
 * the entire lifecycle step between "installed" and "running". Three ways it
 * could go silently wrong, all covered below: touching a trigger it does not
 * own, missing a trigger it does (an absent `enabled` key is TRUE by default),
 * and reporting a change when it made none — which would land an empty commit
 * on the project's default branch every time someone clicked Enable twice.
 */
describe('setCraftTriggersEnabled', () => {
  const triggers = [
    { slug: 'seo-weekly', craft: 'seo-watch', enabled: false },
    { slug: 'seo-daily', craft: 'seo-watch', enabled: false },
    { slug: 'hand-authored', enabled: true },
    { slug: 'other-craft-trigger', craft: 'error-triage', enabled: false },
  ];

  test('enables only the triggers this craft owns', () => {
    const result = setCraftTriggersEnabled(manifest({ triggers }), 'seo-watch', true);
    expect(result.changed).toEqual(['seo-weekly', 'seo-daily']);
    const out = result.manifest.raw.triggers as Record<string, unknown>[];
    expect(out.map((t) => t.enabled)).toEqual([true, true, true, false]);
  });

  test("leaves a hand-authored trigger and another craft's triggers alone", () => {
    const result = setCraftTriggersEnabled(manifest({ triggers }), 'seo-watch', false);
    // Already false, so nothing moves — and critically the OTHER craft's
    // trigger is not swept in.
    expect(result.changed).toEqual([]);
    const out = result.manifest.raw.triggers as Record<string, unknown>[];
    expect(out[2].enabled).toBe(true);
    expect(out[3].enabled).toBe(false);
  });

  test('a trigger with NO enabled key counts as enabled', () => {
    // `parseTriggerEntry` treats absent as enabled. Reading absent as `false`
    // would rewrite every such entry on an enable and produce a commit that
    // changes nothing semantically.
    const result = setCraftTriggersEnabled(
      manifest({ triggers: [{ slug: 'a', craft: 'seo-watch' }] }),
      'seo-watch',
      true,
    );
    expect(result.changed).toEqual([]);
  });

  test('an absent enabled key IS changed when disabling', () => {
    const result = setCraftTriggersEnabled(
      manifest({ triggers: [{ slug: 'a', craft: 'seo-watch' }] }),
      'seo-watch',
      false,
    );
    expect(result.changed).toEqual(['a']);
    expect((result.manifest.raw.triggers as Record<string, unknown>[])[0].enabled).toBe(false);
  });

  test('no change returns the SAME manifest object, so the route skips the commit', () => {
    const input = manifest({ triggers });
    const result = setCraftTriggersEnabled(input, 'seo-watch', false);
    expect(result.manifest).toBe(input);
  });

  test('a manifest with no triggers at all is a no-op, not a throw', () => {
    expect(setCraftTriggersEnabled(manifest({}), 'seo-watch', true).changed).toEqual([]);
    expect(setCraftTriggersEnabled(manifest({ triggers: 'oops' }), 'x', true).changed).toEqual([]);
  });

  test('an unknown craft slug matches nothing', () => {
    expect(setCraftTriggersEnabled(manifest({ triggers }), 'no-such-craft', true).changed).toEqual(
      [],
    );
  });

  test('every other manifest section survives the rewrite', () => {
    const input = manifest({ triggers, kortix_version: 2, agents: { writer: {} }, crafts: [{ slug: 'seo-watch', repo: 'a/b' }] });
    const result = setCraftTriggersEnabled(input, 'seo-watch', true);
    expect(result.manifest.raw.agents).toEqual({ writer: {} });
    expect(result.manifest.raw.crafts).toEqual([{ slug: 'seo-watch', repo: 'a/b' }]);
    expect(result.manifest.raw.kortix_version).toBe(2);
    // And the input is not mutated — the route may retry on a git conflict.
    expect((input.raw.triggers as Record<string, unknown>[])[0].enabled).toBe(false);
  });
});

/**
 * `craftTriggerActivation` — the derived "is this craft running" the installed
 * list serves and the UI switch renders.
 *
 * There is no stored flag on purpose: a craft is on exactly when its triggers
 * are, and a second copy is how a switch and a trigger list end up disagreeing.
 * The interesting case is MIXED — some on, some off — which must be `null`, not
 * rounded to on or off, because a two-state switch that picks one hides the
 * other half.
 */
describe('craftTriggerActivation', () => {
  const withTriggers = (triggers: Record<string, unknown>[]) => manifest({ triggers });

  test('all on → true', () => {
    const result = craftTriggerActivation(
      withTriggers([
        { slug: 'a', craft: 'seo', enabled: true },
        { slug: 'b', craft: 'seo', enabled: true },
      ]),
      'seo',
    );
    expect(result).toEqual({ enabled: true, triggerCount: 2, enabledCount: 2 });
  });

  test('all off → false', () => {
    const result = craftTriggerActivation(
      withTriggers([
        { slug: 'a', craft: 'seo', enabled: false },
        { slug: 'b', craft: 'seo', enabled: false },
      ]),
      'seo',
    );
    expect(result).toEqual({ enabled: false, triggerCount: 2, enabledCount: 0 });
  });

  test('MIXED → null, and the counts say which half', () => {
    const result = craftTriggerActivation(
      withTriggers([
        { slug: 'a', craft: 'seo', enabled: true },
        { slug: 'b', craft: 'seo', enabled: false },
      ]),
      'seo',
    );
    expect(result).toEqual({ enabled: null, triggerCount: 2, enabledCount: 1 });
  });

  test('a craft with no triggers → null, not false', () => {
    // `false` would render an off switch for a craft that has nothing to switch,
    // implying a state it does not have.
    expect(craftTriggerActivation(withTriggers([{ slug: 'a' }]), 'seo')).toEqual({
      enabled: null,
      triggerCount: 0,
      enabledCount: 0,
    });
  });

  test('an absent enabled key counts as ON', () => {
    // Same default `parseTriggerEntry` applies. Reading absent as off would show
    // a running craft as stopped.
    expect(craftTriggerActivation(withTriggers([{ slug: 'a', craft: 'seo' }]), 'seo').enabled).toBe(
      true,
    );
  });

  test("another craft's and hand-authored triggers do not count", () => {
    const result = craftTriggerActivation(
      withTriggers([
        { slug: 'a', craft: 'seo', enabled: false },
        { slug: 'b', craft: 'triage', enabled: true },
        { slug: 'c', enabled: true },
      ]),
      'seo',
    );
    expect(result).toEqual({ enabled: false, triggerCount: 1, enabledCount: 0 });
  });

  test('a manifest with no triggers section is null, not a throw', () => {
    expect(craftTriggerActivation(manifest({}), 'seo').enabled).toBeNull();
    expect(craftTriggerActivation(manifest({ triggers: 'oops' }), 'seo').enabled).toBeNull();
  });
});
