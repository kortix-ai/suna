/**
 * `extractSubprojects` — the read side of the manifest `subprojects:` block.
 *
 * The contract that matters: never throw, and never let one broken entry take
 * the healthy ones offline. A subproject's whole purpose is that its triggers keep
 * firing, so a parse failure has to be reportable, not fatal.
 */
import { describe, expect, test } from 'bun:test';
import { subprojectTriggerActivation, extractSubprojects, setSubprojectTriggersEnabled } from './subprojects';
import type { ParsedManifest } from './triggers';

function manifest(raw: Record<string, unknown>, format: 'yaml' | 'toml' = 'yaml'): ParsedManifest {
  return { schemaVersion: 2, raw, format, path: 'kortix.yaml', revision: null };
}

const FULL = {
  slug: 'seo-watch',
  repo: 'acme/seo-subproject',
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

describe('extractSubprojects', () => {
  test('an absent section is zero subprojects, not an error', () => {
    expect(extractSubprojects(manifest({}))).toEqual({ specs: [], errors: [] });
    expect(extractSubprojects(manifest({ subprojects: null }))).toEqual({ specs: [], errors: [] });
  });

  test('a full entry parses every field, splitting ref (asked for) from sha (resolved)', () => {
    const { specs, errors } = extractSubprojects(manifest({ subprojects: [FULL] }));
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual({
      slug: 'seo-watch',
      path: 'kortix.yaml#subprojects.seo-watch',
      repoOwner: 'acme',
      repoName: 'seo-subproject',
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
    const { specs, errors } = extractSubprojects(
      manifest({ subprojects: [{ slug: 'standup', repo: 'kortix-ai/standup' }] }),
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
    const { specs, errors } = extractSubprojects(
      manifest({
        subprojects: [
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
    const { specs, errors } = extractSubprojects(
      manifest({
        subprojects: [
          { slug: 'standup', repo: 'first/one' },
          { slug: 'standup', repo: 'second/two' },
        ],
      }),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].repoOwner).toBe('first');
    expect(errors[0].error).toContain('Duplicate subproject slug');
  });

  test('a non-list section reports once, with format-specific wording', () => {
    const yaml = extractSubprojects(manifest({ subprojects: { standup: {} } }, 'yaml'));
    expect(yaml.specs).toEqual([]);
    expect(yaml.errors).toHaveLength(1);
    expect(yaml.errors[0].error).toContain('YAML `subprojects:` list');

    const toml = extractSubprojects(manifest({ subprojects: 'nope' }, 'toml'));
    expect(toml.errors[0].error).toContain('[[subprojects]]');
  });

  test('owns drops unknown kinds and non-slug names, then dedupes and sorts', () => {
    const { specs } = extractSubprojects(
      manifest({
        subprojects: [
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
    const { specs } = extractSubprojects(
      manifest({ subprojects: [{ slug: 'c', repo: 'a/b', ref: '   ', sha: '', title: '' }] }),
    );
    expect(specs[0].gitRef).toBeNull();
    expect(specs[0].resolvedSha).toBeNull();
    expect(specs[0].title).toBe('c');
  });

  test('the path breadcrumb follows the manifest file actually read', () => {
    const m = manifest({ subprojects: [{ slug: 'c', repo: 'a/b' }] }, 'toml');
    m.path = 'kortix.toml';
    expect(extractSubprojects(m).specs[0].path).toBe('kortix.toml#subprojects.c');
  });
});

/**
 * `setSubprojectTriggersEnabled` — what actually starts a subproject working.
 *
 * A subproject installs with every trigger `enabled: false`, so this transform is
 * the entire lifecycle step between "installed" and "running". Three ways it
 * could go silently wrong, all covered below: touching a trigger it does not
 * own, missing a trigger it does (an absent `enabled` key is TRUE by default),
 * and reporting a change when it made none — which would land an empty commit
 * on the project's default branch every time someone clicked Enable twice.
 */
describe('setSubprojectTriggersEnabled', () => {
  const triggers = [
    { slug: 'seo-weekly', subproject: 'seo-watch', enabled: false },
    { slug: 'seo-daily', subproject: 'seo-watch', enabled: false },
    { slug: 'hand-authored', enabled: true },
    { slug: 'other-subproject-trigger', subproject: 'error-triage', enabled: false },
  ];

  test('enables only the triggers this subproject owns', () => {
    const result = setSubprojectTriggersEnabled(manifest({ triggers }), 'seo-watch', true);
    expect(result.changed).toEqual(['seo-weekly', 'seo-daily']);
    const out = result.manifest.raw.triggers as Record<string, unknown>[];
    expect(out.map((t) => t.enabled)).toEqual([true, true, true, false]);
  });

  test("leaves a hand-authored trigger and another subproject's triggers alone", () => {
    const result = setSubprojectTriggersEnabled(manifest({ triggers }), 'seo-watch', false);
    // Already false, so nothing moves — and critically the OTHER subproject's
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
    const result = setSubprojectTriggersEnabled(
      manifest({ triggers: [{ slug: 'a', subproject: 'seo-watch' }] }),
      'seo-watch',
      true,
    );
    expect(result.changed).toEqual([]);
  });

  test('an absent enabled key IS changed when disabling', () => {
    const result = setSubprojectTriggersEnabled(
      manifest({ triggers: [{ slug: 'a', subproject: 'seo-watch' }] }),
      'seo-watch',
      false,
    );
    expect(result.changed).toEqual(['a']);
    expect((result.manifest.raw.triggers as Record<string, unknown>[])[0].enabled).toBe(false);
  });

  test('no change returns the SAME manifest object, so the route skips the commit', () => {
    const input = manifest({ triggers });
    const result = setSubprojectTriggersEnabled(input, 'seo-watch', false);
    expect(result.manifest).toBe(input);
  });

  test('a manifest with no triggers at all is a no-op, not a throw', () => {
    expect(setSubprojectTriggersEnabled(manifest({}), 'seo-watch', true).changed).toEqual([]);
    expect(setSubprojectTriggersEnabled(manifest({ triggers: 'oops' }), 'x', true).changed).toEqual([]);
  });

  test('an unknown subproject slug matches nothing', () => {
    expect(setSubprojectTriggersEnabled(manifest({ triggers }), 'no-such-subproject', true).changed).toEqual(
      [],
    );
  });

  test('every other manifest section survives the rewrite', () => {
    const input = manifest({ triggers, kortix_version: 2, agents: { writer: {} }, subprojects: [{ slug: 'seo-watch', repo: 'a/b' }] });
    const result = setSubprojectTriggersEnabled(input, 'seo-watch', true);
    expect(result.manifest.raw.agents).toEqual({ writer: {} });
    expect(result.manifest.raw.subprojects).toEqual([{ slug: 'seo-watch', repo: 'a/b' }]);
    expect(result.manifest.raw.kortix_version).toBe(2);
    // And the input is not mutated — the route may retry on a git conflict.
    expect((input.raw.triggers as Record<string, unknown>[])[0].enabled).toBe(false);
  });
});

/**
 * `subprojectTriggerActivation` — the derived "is this subproject running" the installed
 * list serves and the UI switch renders.
 *
 * There is no stored flag on purpose: a subproject is on exactly when its triggers
 * are, and a second copy is how a switch and a trigger list end up disagreeing.
 * The interesting case is MIXED — some on, some off — which must be `null`, not
 * rounded to on or off, because a two-state switch that picks one hides the
 * other half.
 */
describe('subprojectTriggerActivation', () => {
  const withTriggers = (triggers: Record<string, unknown>[]) => manifest({ triggers });

  test('all on → true', () => {
    const result = subprojectTriggerActivation(
      withTriggers([
        { slug: 'a', subproject: 'seo', enabled: true },
        { slug: 'b', subproject: 'seo', enabled: true },
      ]),
      'seo',
    );
    expect(result).toEqual({ enabled: true, triggerCount: 2, enabledCount: 2 });
  });

  test('all off → false', () => {
    const result = subprojectTriggerActivation(
      withTriggers([
        { slug: 'a', subproject: 'seo', enabled: false },
        { slug: 'b', subproject: 'seo', enabled: false },
      ]),
      'seo',
    );
    expect(result).toEqual({ enabled: false, triggerCount: 2, enabledCount: 0 });
  });

  test('MIXED → null, and the counts say which half', () => {
    const result = subprojectTriggerActivation(
      withTriggers([
        { slug: 'a', subproject: 'seo', enabled: true },
        { slug: 'b', subproject: 'seo', enabled: false },
      ]),
      'seo',
    );
    expect(result).toEqual({ enabled: null, triggerCount: 2, enabledCount: 1 });
  });

  test('a subproject with no triggers → null, not false', () => {
    // `false` would render an off switch for a subproject that has nothing to switch,
    // implying a state it does not have.
    expect(subprojectTriggerActivation(withTriggers([{ slug: 'a' }]), 'seo')).toEqual({
      enabled: null,
      triggerCount: 0,
      enabledCount: 0,
    });
  });

  test('an absent enabled key counts as ON', () => {
    // Same default `parseTriggerEntry` applies. Reading absent as off would show
    // a running subproject as stopped.
    expect(subprojectTriggerActivation(withTriggers([{ slug: 'a', subproject: 'seo' }]), 'seo').enabled).toBe(
      true,
    );
  });

  test("another subproject's and hand-authored triggers do not count", () => {
    const result = subprojectTriggerActivation(
      withTriggers([
        { slug: 'a', subproject: 'seo', enabled: false },
        { slug: 'b', subproject: 'triage', enabled: true },
        { slug: 'c', enabled: true },
      ]),
      'seo',
    );
    expect(result).toEqual({ enabled: false, triggerCount: 1, enabledCount: 0 });
  });

  test('a manifest with no triggers section is null, not a throw', () => {
    expect(subprojectTriggerActivation(manifest({}), 'seo').enabled).toBeNull();
    expect(subprojectTriggerActivation(manifest({ triggers: 'oops' }), 'seo').enabled).toBeNull();
  });
});
