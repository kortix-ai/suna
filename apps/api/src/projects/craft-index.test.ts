/**
 * `crawlCraftRepo` — a GitHub repo becomes one craft card.
 *
 * Driven against a stub GitHub so the semantics are pinned deterministically:
 * candidate-path precedence, sha pinning, the manifest gate, and what the card
 * derives. The live negative paths (a real repo with no manifest, a real
 * missing repo, the 422-on-a-bad-ref that GitHub actually returns) are proven
 * separately against the real API — see the commit message.
 */
import { describe, expect, test } from 'bun:test';
import { type CraftCrawlError, craftSlugFromRepo, crawlCraftRepo } from './craft-index';

const SHA = 'a'.repeat(40);

const CRAFT_YAML = `kortix_version: 2
default_agent: seo-writer

project:
  name: SEO watch
  description: Audits the site weekly and opens a change request.

env:
  required: [SEARCH_CONSOLE_KEY, other_key]

agents:
  seo-writer:
    skills: [seo-audit, sitemap-diff]
    connectors: [search-console]
  helper:
    skills: [seo-audit]

connectors:
  - slug: search-console
    provider: composio
    app: google_search_console

triggers:
  - slug: seo-weekly
    name: Weekly SEO sweep
    type: cron
    agent: seo-writer
    enabled: false
    cron: "0 0 9 * * 1"
    prompt: Audit the site and open a CR.
`;

interface StubOptions {
  /** path → body. A path absent from the map answers 404. */
  files?: Record<string, string>;
  defaultBranch?: string;
  stars?: number | null;
  description?: string | null;
  /** Status overrides keyed by a substring of the URL. */
  status?: Array<[string, number]>;
}

/** A stub GitHub that records every URL the crawl requested, in order. */
function stubGithub(opts: StubOptions = {}) {
  const files = opts.files ?? { 'kortix.yaml': CRAFT_YAML };
  const calls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push(url);
    for (const [needle, status] of opts.status ?? []) {
      if (url.includes(needle)) return new Response('', { status });
    }
    if (url.includes('/commits/')) {
      return Response.json({ sha: SHA });
    }
    if (url.startsWith('https://api.github.com/repos/')) {
      return Response.json({
        default_branch: opts.defaultBranch ?? 'main',
        stargazers_count: opts.stars === undefined ? 128 : opts.stars,
        description: opts.description === undefined ? 'A repo blurb' : opts.description,
      });
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      const path = url.split(`/${SHA}/`)[1] ?? '';
      const body = files[path];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    }
    return new Response('', { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function crawl(address: string, opts: StubOptions = {}) {
  const { fetchImpl, calls } = stubGithub(opts);
  const result = await crawlCraftRepo(address, { fetchImpl });
  return { result, calls };
}

async function crawlErr(address: string, opts: StubOptions = {}): Promise<CraftCrawlError> {
  const { fetchImpl } = stubGithub(opts);
  try {
    await crawlCraftRepo(address, { fetchImpl });
  } catch (e) {
    return e as CraftCrawlError;
  }
  throw new Error('expected a CraftCrawlError');
}

describe('crawlCraftRepo — the card', () => {
  test('derives identity, provenance and the card from the manifest', async () => {
    const { result } = await crawl('acme/seo-craft');
    expect(result.slug).toBe('seo-craft');
    expect(result.repoOwner).toBe('acme');
    expect(result.repoName).toBe('seo-craft');
    expect(result.gitRef).toBeNull();
    expect(result.resolvedRef).toBe('main');
    expect(result.resolvedSha).toBe(SHA);
    expect(result.manifestPath).toBe('kortix.yaml');
    expect(result.stars).toBe(128);
  });

  test("the manifest's project name and description beat GitHub's blurb", async () => {
    const { result } = await crawl('acme/seo-craft');
    expect(result.title).toBe('SEO watch');
    expect(result.description).toBe('Audits the site weekly and opens a change request.');
  });

  test("GitHub's blurb is the fallback when the manifest declares none", async () => {
    const { result } = await crawl('acme/seo-craft', {
      files: { 'kortix.yaml': 'kortix_version: 2\ndefault_agent: a\nagents:\n  a: {}\n' },
    });
    expect(result.title).toBe('seo-craft');
    expect(result.description).toBe('A repo blurb');
  });

  test('an un-rendered {{projectName}} placeholder never becomes the title', async () => {
    // A craft submitted straight from the starter template would otherwise be
    // listed in the store as literally "{{projectName}}".
    const { result } = await crawl('acme/seo-craft', {
      files: {
        'kortix.yaml':
          'kortix_version: 2\ndefault_agent: a\nproject:\n  name: "{{projectName}}"\nagents:\n  a: {}\n',
      },
    });
    expect(result.title).toBe('seo-craft');
  });

  test('agents, triggers and connectors come from the runtime parsers', async () => {
    const { result } = await crawl('acme/seo-craft');
    expect(result.agents.map((a) => a.name).sort()).toEqual(['helper', 'seo-writer']);
    expect(result.triggers).toEqual([
      {
        slug: 'seo-weekly',
        name: 'Weekly SEO sweep',
        type: 'cron',
        cron: '0 0 9 * * 1',
        agent: 'seo-writer',
        enabled: false,
      },
    ]);
    expect(result.connectors).toEqual([
      { slug: 'search-console', provider: 'composio', app: 'google_search_console' },
    ]);
  });

  test('skills are the deduped, sorted union of the agents\u2019 grants', async () => {
    const { result } = await crawl('acme/seo-craft');
    expect(result.skills).toEqual(['seo-audit', 'sitemap-diff']);
  });

  test('an "all" skills grant contributes no names — it is not a knowable set', async () => {
    const { result } = await crawl('acme/seo-craft', {
      files: {
        'kortix.yaml':
          'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    skills: all\n  b:\n    skills: [named]\n',
      },
    });
    expect(result.skills).toEqual(['named']);
  });

  test('required env is upper-cased, deduped and sorted', async () => {
    const { result } = await crawl('acme/seo-craft');
    expect(result.envRequired).toEqual(['OTHER_KEY', 'SEARCH_CONSOLE_KEY']);
  });
});

describe('crawlCraftRepo — sha pinning', () => {
  test('the manifest is read AT THE SHA, never at the branch', async () => {
    // This is what makes the cached manifest and resolved_sha columns
    // incapable of disagreeing: a push landing mid-crawl cannot be picked up.
    const { calls } = await crawl('acme/seo-craft');
    const raw = calls.find((c) => c.startsWith('https://raw.githubusercontent.com/'));
    expect(raw).toBe(`https://raw.githubusercontent.com/acme/seo-craft/${SHA}/kortix.yaml`);
    expect(raw).not.toContain('/main/');
  });

  test('the repo metadata and ref are resolved before the manifest is read', async () => {
    const { calls } = await crawl('acme/seo-craft');
    const meta = calls.findIndex((c) => c === 'https://api.github.com/repos/acme/seo-craft');
    const commit = calls.findIndex((c) => c.includes('/commits/'));
    const raw = calls.findIndex((c) => c.startsWith('https://raw.'));
    expect(meta).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(meta);
    expect(raw).toBeGreaterThan(commit);
  });

  test('a pinned ref is recorded AND used to resolve the sha', async () => {
    const { result, calls } = await crawl('acme/seo-craft@v1.2.0');
    expect(result.gitRef).toBe('v1.2.0');
    expect(result.resolvedRef).toBe('v1.2.0');
    expect(calls.some((c) => c.endsWith('/commits/v1.2.0'))).toBe(true);
  });

  test("an unpinned craft follows the repo's real default branch", async () => {
    const { result, calls } = await crawl('acme/seo-craft', { defaultBranch: 'trunk' });
    expect(result.gitRef).toBeNull();
    expect(result.resolvedRef).toBe('trunk');
    expect(calls.some((c) => c.endsWith('/commits/trunk'))).toBe(true);
  });
});

describe('crawlCraftRepo — manifest discovery', () => {
  test('kortix.yml is accepted when kortix.yaml is absent', async () => {
    const { result } = await crawl('acme/seo-craft', { files: { 'kortix.yml': CRAFT_YAML } });
    expect(result.manifestPath).toBe('kortix.yml');
  });

  test('a legacy kortix.toml is accepted', async () => {
    const { result } = await crawl('acme/seo-craft', {
      files: { 'kortix.toml': 'kortix_version = 1\n[project]\nname = "Legacy craft"\n' },
    });
    expect(result.manifestPath).toBe('kortix.toml');
    expect(result.title).toBe('Legacy craft');
  });

  test('yaml wins when several candidates exist', async () => {
    const { result } = await crawl('acme/seo-craft', {
      files: { 'kortix.yaml': CRAFT_YAML, 'kortix.yml': CRAFT_YAML, 'kortix.toml': 'x = 1' },
    });
    expect(result.manifestPath).toBe('kortix.yaml');
  });
});

describe('crawlCraftRepo — rejections carry an actionable code', () => {
  test('a non-GitHub address is rejected before any network call', async () => {
    const { fetchImpl, calls } = stubGithub();
    await expect(crawlCraftRepo('https://gitlab.com/a/b', { fetchImpl })).rejects.toThrow(
      /not a GitHub repository/,
    );
    expect(calls).toEqual([]);
  });

  test('no manifest anywhere → manifest_not_found, naming every candidate', async () => {
    const err = await crawlErr('acme/seo-craft', { files: {} });
    expect(err.code).toBe('manifest_not_found');
    expect(err.message).toContain('kortix.yaml');
    expect(err.message).toContain('kortix.toml');
  });

  test('an invalid manifest → manifest_invalid, carrying the issue paths', async () => {
    const err = await crawlErr('acme/seo-craft', {
      // v2 requires default_agent + a non-empty agents map.
      files: { 'kortix.yaml': 'kortix_version: 2\nagents: {}\n' },
    });
    expect(err.code).toBe('manifest_invalid');
    expect(err.issues.length).toBeGreaterThan(0);
    expect(err.issues.map((i) => i.path)).toContain('agents');
  });

  test('a 404 on the repo → repo_not_found', async () => {
    const err = await crawlErr('acme/seo-craft', { status: [['/repos/acme/seo-craft', 404]] });
    expect(err.code).toBe('repo_not_found');
  });

  test('a 422 on the ref → ref_not_found, NOT a server error', async () => {
    // Measured against the real API: GitHub answers an unresolvable ref with
    // 422, not 404. Classifying it as upstream_unavailable would page on what
    // is a typo in a branch name.
    const err = await crawlErr('acme/seo-craft@nope', { status: [['/commits/', 422]] });
    expect(err.code).toBe('ref_not_found');
  });

  test('a 500 from GitHub stays upstream_unavailable', async () => {
    const err = await crawlErr('acme/seo-craft', { status: [['/repos/acme/seo-craft', 503]] });
    expect(err.code).toBe('upstream_unavailable');
  });

  test('a manifest version the reader refuses → manifest_unsupported', async () => {
    const err = await crawlErr('acme/seo-craft', {
      files: { 'kortix.yaml': 'kortix_version: 99\n' },
    });
    expect(['manifest_unsupported', 'manifest_invalid']).toContain(err.code);
  });
});

describe('crawlCraftRepo — warnings never block', () => {
  test('a source manifest that declares installed crafts is indexed, with a warning', async () => {
    // A craft does not install other crafts. Indexing it anyway but saying so
    // beats refusing a repo over a stanza nobody will honor.
    const { result } = await crawl('acme/seo-craft', {
      files: {
        'kortix.yaml': `${CRAFT_YAML}\ncrafts:\n  - slug: nested\n    repo: other/thing\n`,
      },
    });
    expect(result.slug).toBe('seo-craft');
    expect(result.warnings.some((w) => w.includes('does not install other crafts'))).toBe(true);
  });
});

describe('craftSlugFromRepo', () => {
  const cases: Array<[string, string]> = [
    ['seo-craft', 'seo-craft'],
    ['SEO_Craft', 'seo_craft'],
    ['My Craft!', 'my-craft'],
    ['--weird--', 'weird'],
    ['...', 'craft'],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" → "${expected}"`, () => expect(craftSlugFromRepo(input)).toBe(expected));
  }
});
