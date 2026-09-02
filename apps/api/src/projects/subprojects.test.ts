/**
 * `extractSubprojects` — the read side of the manifest `subprojects:` block.
 *
 * The contract that matters: never throw, and never let one broken entry take
 * the healthy ones offline. A subproject's whole purpose is that its triggers keep
 * firing, so a parse failure has to be reportable, not fatal.
 */
import { describe, expect, test } from 'bun:test';
import { extractSubprojects } from './subprojects';
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
