import { describe, expect, test } from 'bun:test';
import type { CompanyProfile, ProfileProvenance } from '../schemas';
import {
  INDEX_HEADING,
  MEMORY_INDEX_PATH,
  profileRepoPath,
  renderProfileMarkdown,
  slugForUrl,
  writeProfileToMemory,
  type MemoryPageContent,
  type MemoryPort,
} from './memory-write';

const PROVENANCE: ProfileProvenance = {
  domain: 'example.com',
  crawledAt: '2026-07-24T12:00:00.000Z',
  crawlStatus: 'complete',
  model: 'glm-5.2',
};

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    subjectType: 'company',
    name: 'Example Inc',
    tagline: 'We do things',
    description: 'Example Inc builds tools for teams.',
    products: [
      { name: 'Widget', description: 'A widget', url: 'https://example.com/widget', audience: null },
    ],
    team: [
      { name: 'Ada Lovelace', role: 'CEO', link: 'https://example.com/team/ada', bio: null },
    ],
    socials: [{ platform: 'twitter', url: 'https://twitter.com/example' }],
    pricingSummary: 'Free tier plus paid plans.',
    pricing: { model: null, currency: null, freeTier: null, tiers: [] },
    blogPosts: [
      { title: 'Launch', url: 'https://example.com/blog/launch', date: '2026-01-02', summary: null, tags: [] },
    ],
    contact: { email: 'hi@example.com', phone: null, address: null },
    sectionSources: [{ section: 'team', urls: ['https://example.com/team'] }],
    sources: ['https://example.com/', 'https://example.com/team'],
    keyFacts: [],
    positioning: null,
    integrations: [],
    techStack: [],
    caseStudies: [],
    faq: [],
    locations: [],
    founded: null,
    headline: null,
    bio: null,
    roles: [],
    projects: [],
    writing: [],
    skills: [],
    speaking: [],
    ...overrides,
  };
}

function page(url: string, markdown: string, tier: MemoryPageContent['tier'] = 'jina'): MemoryPageContent {
  return { url, markdown, tier };
}

function memoryPort(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const commits: Array<{
    files: Array<{ path: string; content: string }>;
    deletes: string[];
    message: string;
  }> = [];
  const port: MemoryPort = {
    read: async (path) => files.get(path) ?? null,
    commitMany: async ({ files: writes, deletes, message }) => {
      commits.push({ files: writes, deletes, message });
      for (const f of writes) files.set(f.path, f.content);
      for (const d of deletes) files.delete(d);
    },
  };
  return { port, files, commits };
}

describe('profileRepoPath', () => {
  test('places the profile inside the domain folder', () => {
    expect(profileRepoPath('example.com')).toBe('.kortix/memory/enrichment/example.com/profile.md');
  });
});

describe('slugForUrl', () => {
  test('lowercases and collapses non-alphanumerics', () => {
    expect(slugForUrl('https://example.com/About-Us/')).toBe('about-us');
  });

  test('falls back to index for the root path', () => {
    expect(slugForUrl('https://example.com/')).toBe('index');
    expect(slugForUrl('https://example.com')).toBe('index');
  });

  test('caps length at 80 characters', () => {
    const slug = slugForUrl(`https://example.com/${'a'.repeat(200)}`);
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  test('falls back to index when the path collapses to nothing', () => {
    expect(slugForUrl('https://example.com/???')).toBe('index');
  });
});

describe('renderProfileMarkdown', () => {
  test('titles the document with the company name', () => {
    expect(renderProfileMarkdown(profile(), PROVENANCE)).toContain('# Example Inc');
  });

  test('falls back to the domain when the name is unknown', () => {
    expect(renderProfileMarkdown(profile({ name: null }), PROVENANCE)).toContain('# example.com');
  });

  test('records provenance', () => {
    const md = renderProfileMarkdown(profile(), PROVENANCE);
    expect(md).toContain('2026-07-24T12:00:00.000Z');
    expect(md).toContain('example.com');
    expect(md).toContain('glm-5.2');
  });

  test('renders every populated section', () => {
    const md = renderProfileMarkdown(profile(), PROVENANCE);
    for (const heading of ['## Overview', '## Products', '## Pricing', '## Team', '## Contact', '## Social', '## Recent posts', '## Sources']) {
      expect(md).toContain(heading);
    }
  });

  test('omits sections with no content', () => {
    const md = renderProfileMarkdown(
      profile({ products: [], team: [], socials: [], blogPosts: [], pricingSummary: null }),
      PROVENANCE,
    );
    expect(md).not.toContain('## Products');
    expect(md).not.toContain('## Team');
    expect(md).not.toContain('## Pricing');
  });

  test('falls back to the headline when tagline is unset', () => {
    const md = renderProfileMarkdown(profile({ tagline: null, headline: 'Mathematician' }), PROVENANCE);
    expect(md).toContain('_Mathematician_');
  });

  test('prefers tagline over headline when both are set', () => {
    const md = renderProfileMarkdown(profile({ headline: 'Mathematician' }), PROVENANCE);
    expect(md).toContain('_We do things_');
    expect(md).not.toContain('_Mathematician_');
  });

  test('falls back to bio for the overview when description is unset', () => {
    const md = renderProfileMarkdown(profile({ description: null, bio: 'Writes about engines.' }), PROVENANCE);
    expect(md).toContain('## Overview');
    expect(md).toContain('Writes about engines.');
  });

  test('renders key facts', () => {
    const md = renderProfileMarkdown(
      profile({ keyFacts: [{ label: 'Founded', value: '2015' }] }),
      PROVENANCE,
    );
    expect(md).toContain('## Key facts');
    expect(md).toContain('- **Founded:** 2015');
  });

  test('renders positioning', () => {
    const md = renderProfileMarkdown(profile({ positioning: 'The simplest way to ship widgets.' }), PROVENANCE);
    expect(md).toContain('## Positioning');
    expect(md).toContain('The simplest way to ship widgets.');
  });

  test('renders experience from roles', () => {
    const md = renderProfileMarkdown(
      profile({
        roles: [
          { title: 'Collaborator', org: 'Analytical Engine Project', start: '1842', end: '1843', summary: 'Wrote the first published algorithm.' },
        ],
      }),
      PROVENANCE,
    );
    expect(md).toContain('## Experience');
    expect(md).toContain('Collaborator');
    expect(md).toContain('Analytical Engine Project');
    expect(md).toContain('Wrote the first published algorithm.');
  });

  test('renders projects with a link when a url is known', () => {
    const md = renderProfileMarkdown(
      profile({
        projects: [
          { name: 'Notes on the Analytical Engine', url: 'https://example.com/notes', description: 'An extended commentary.', tech: [] },
        ],
      }),
      PROVENANCE,
    );
    expect(md).toContain('## Projects');
    expect(md).toContain('[Notes on the Analytical Engine](https://example.com/notes)');
    expect(md).toContain('An extended commentary.');
  });

  test('omits key facts, positioning, experience and projects when empty', () => {
    const md = renderProfileMarkdown(profile(), PROVENANCE);
    expect(md).not.toContain('## Key facts');
    expect(md).not.toContain('## Positioning');
    expect(md).not.toContain('## Experience');
    expect(md).not.toContain('## Projects');
  });

  test('links team members and products when a url is known', () => {
    const md = renderProfileMarkdown(profile(), PROVENANCE);
    expect(md).toContain('[Ada Lovelace](https://example.com/team/ada)');
    expect(md).toContain('[Widget](https://example.com/widget)');
  });

  test('lists every source url', () => {
    const md = renderProfileMarkdown(profile(), PROVENANCE);
    expect(md).toContain('- https://example.com/');
    expect(md).toContain('- https://example.com/team');
  });

  test('embeds the validated json', () => {
    const md = renderProfileMarkdown(profile(), PROVENANCE);
    const fenced = md.slice(md.indexOf('```json') + 7, md.lastIndexOf('```'));
    expect(JSON.parse(fenced).name).toBe('Example Inc');
  });

  test('warns when the crawl was partial', () => {
    const md = renderProfileMarkdown(profile(), { ...PROVENANCE, crawlStatus: 'partial' });
    expect(md).toContain('partial');
  });
});

describe('writeProfileToMemory — folder layout', () => {
  test('writes the profile under the domain folder', async () => {
    const mem = memoryPort();
    const result = await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    expect(result.profilePath).toBe('.kortix/memory/enrichment/example.com/profile.md');
    expect(mem.files.get(result.profilePath)).toContain('# Example Inc');
  });

  test('writes each page under pages/<slug>.md and each blog post under blog/<slug>.md', async () => {
    const mem = memoryPort();
    const result = await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [page('https://example.com/about', 'About body')],
      blogPosts: [page('https://example.com/blog/launch', 'Launch body', 'direct')],
    });

    expect(result.pagePaths).toEqual(['.kortix/memory/enrichment/example.com/pages/about.md']);
    expect(result.blogPaths).toEqual(['.kortix/memory/enrichment/example.com/blog/blog-launch.md']);
    expect(mem.files.get(result.pagePaths[0])).toContain('About body');
    expect(mem.files.get(result.blogPaths[0])).toContain('Launch body');
  });

  test('renders page front matter with source, fetchedAt and tier', async () => {
    const mem = memoryPort();
    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [page('https://example.com/about', '# About\n\nWe do things.', 'firecrawl')],
    });

    const content = mem.files.get('.kortix/memory/enrichment/example.com/pages/about.md')!;
    expect(content).toContain('source: "https://example.com/about"');
    expect(content).toContain(`fetchedAt: "${PROVENANCE.crawledAt}"`);
    expect(content).toContain('tier: firecrawl');
    expect(content).toContain('We do things.');
  });

  test('slug collisions get a distinct numeric suffix', async () => {
    const mem = memoryPort();
    const result = await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [
        page('https://example.com/about', 'One'),
        page('https://example.com/About/', 'Two'),
      ],
    });

    expect(result.pagePaths.sort()).toEqual([
      '.kortix/memory/enrichment/example.com/pages/about-2.md',
      '.kortix/memory/enrichment/example.com/pages/about.md',
    ]);
  });

  test('two slugs that both hit the 80-character cap still get distinct paths', async () => {
    const mem = memoryPort();
    const longBase = 'a'.repeat(80);
    const result = await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [
        page(`https://example.com/${longBase}-one`, 'One'),
        page(`https://example.com/${longBase}-two`, 'Two'),
      ],
    });

    expect(result.pagePaths).toHaveLength(2);
    expect(result.pagePaths[0]).not.toBe(result.pagePaths[1]);
    expect(mem.files.get(result.pagePaths[0])).toContain('One');
    expect(mem.files.get(result.pagePaths[1])).toContain('Two');
  });
});

describe('writeProfileToMemory — MEMORY.md index', () => {
  test('lists the profile, every page and every blog post', async () => {
    const mem = memoryPort();
    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [page('https://example.com/about', 'About body')],
      blogPosts: [page('https://example.com/blog/launch', 'Launch body')],
    });

    const index = mem.files.get(MEMORY_INDEX_PATH)!;
    expect(index).toContain(INDEX_HEADING);
    expect(index).toContain('enrichment/example.com/profile.md');
    expect(index).toContain('enrichment/example.com/pages/about.md');
    expect(index).toContain('enrichment/example.com/blog/blog-launch.md');
  });

  test('preserves existing preamble content outside the section', async () => {
    const mem = memoryPort({ [MEMORY_INDEX_PATH]: '# Project Memory\n\nSome preamble.\n' });
    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    expect(mem.files.get(MEMORY_INDEX_PATH)).toContain('Some preamble.');
  });

  test('appends alongside an existing domain block', async () => {
    const mem = memoryPort({
      [MEMORY_INDEX_PATH]: `# Project Memory\n\n${INDEX_HEADING}\n\n- **other.com**\n  - [profile](enrichment/other.com/profile.md)\n`,
    });
    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    const index = mem.files.get(MEMORY_INDEX_PATH)!;
    expect(index).toContain('enrichment/other.com/profile.md');
    expect(index).toContain('enrichment/example.com/profile.md');
  });

  test('replaces the block for a domain already indexed rather than duplicating it', async () => {
    const mem = memoryPort();
    const args = {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [page('https://example.com/about', 'About body')],
    };
    await writeProfileToMemory(mem.port, args);
    await writeProfileToMemory(mem.port, { ...args, profile: profile({ tagline: 'A new tagline' }) });

    const index = mem.files.get(MEMORY_INDEX_PATH)!;
    expect(index.match(/enrichment\/example\.com\/profile\.md/g)).toHaveLength(1);
    expect(index.match(/enrichment\/example\.com\/pages\/about\.md/g)).toHaveLength(1);
    expect(index).toContain('A new tagline');
  });

  test('drops a page that no longer exists on the next run, from both disk and the index', async () => {
    const mem = memoryPort();
    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [
        page('https://example.com/about', 'About body'),
        page('https://example.com/team', 'Team body'),
      ],
    });
    expect(mem.files.has('.kortix/memory/enrichment/example.com/pages/team.md')).toBe(true);

    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [page('https://example.com/about', 'About body v2')],
    });

    expect(mem.files.has('.kortix/memory/enrichment/example.com/pages/team.md')).toBe(false);
    expect(mem.commits.at(-1)!.deletes).toContain('.kortix/memory/enrichment/example.com/pages/team.md');
    expect(mem.files.get(MEMORY_INDEX_PATH)).not.toContain('pages/team.md');
  });

  test('omitting pages/blogPosts preserves them; an explicit empty array deletes them', async () => {
    const mem = memoryPort();
    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [page('https://example.com/about', 'About body')],
      blogPosts: [page('https://example.com/blog/launch', 'Launch body')],
    });

    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile({ tagline: 'omitted run' }),
      provenance: PROVENANCE,
    });

    expect(mem.files.has('.kortix/memory/enrichment/example.com/pages/about.md')).toBe(true);
    expect(mem.files.has('.kortix/memory/enrichment/example.com/blog/blog-launch.md')).toBe(true);
    expect(mem.commits.at(-1)!.deletes).toEqual([]);
    expect(mem.files.get(MEMORY_INDEX_PATH)).toContain('pages/about.md');
    expect(mem.files.get(MEMORY_INDEX_PATH)).toContain('blog/blog-launch.md');

    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile({ tagline: 'confirmed empty run' }),
      provenance: PROVENANCE,
      pages: [],
      blogPosts: [],
    });

    expect(mem.files.has('.kortix/memory/enrichment/example.com/pages/about.md')).toBe(false);
    expect(mem.files.has('.kortix/memory/enrichment/example.com/blog/blog-launch.md')).toBe(false);
    expect(mem.commits.at(-1)!.deletes.sort()).toEqual(
      [
        '.kortix/memory/enrichment/example.com/pages/about.md',
        '.kortix/memory/enrichment/example.com/blog/blog-launch.md',
      ].sort(),
    );
    expect(mem.files.get(MEMORY_INDEX_PATH)).not.toContain('pages/about.md');
    expect(mem.files.get(MEMORY_INDEX_PATH)).not.toContain('blog/blog-launch.md');
  });

  test('ignores a domain-shaped bullet living outside the Enriched companies section', async () => {
    const decoyLine = '- **example.com** — a note an agent left elsewhere, not the real index block';
    const decoyChild = '  - not a generated file, just prose';
    const seed = [
      '# Project Memory',
      '',
      decoyLine,
      decoyChild,
      '',
      INDEX_HEADING,
      '',
      '- **example.com**',
      '  - [profile](enrichment/example.com/profile.md)',
      '',
    ].join('\n');
    const mem = memoryPort({ [MEMORY_INDEX_PATH]: seed });

    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile({ tagline: 'Updated tagline' }),
      provenance: PROVENANCE,
    });

    const index = mem.files.get(MEMORY_INDEX_PATH)!;
    expect(index).toContain(decoyLine);
    expect(index).toContain(decoyChild);
    expect(index).toContain('Updated tagline');
    expect(index.match(/\[profile\]\(enrichment\/example\.com\/profile\.md\)/g)).toHaveLength(1);
  });

  test('writes the whole folder plus the index in exactly one commit', async () => {
    const mem = memoryPort();
    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
      pages: [page('https://example.com/about', 'About body')],
      blogPosts: [page('https://example.com/blog/launch', 'Launch body')],
    });

    expect(mem.commits).toHaveLength(1);
    expect(mem.commits[0].files.map((f) => f.path).sort()).toEqual(
      [
        MEMORY_INDEX_PATH,
        '.kortix/memory/enrichment/example.com/profile.md',
        '.kortix/memory/enrichment/example.com/pages/about.md',
        '.kortix/memory/enrichment/example.com/blog/blog-launch.md',
      ].sort(),
    );
  });
});

describe('writeProfileToMemory — commit retries', () => {
  test('retries a commit that loses the compare-and-swap race', async () => {
    const mem = memoryPort();
    let attempts = 0;
    const flaky: MemoryPort = {
      read: mem.port.read,
      commitMany: async (args) => {
        attempts += 1;
        if (attempts === 1) throw new Error('ref update failed');
        return mem.port.commitMany(args);
      },
    };

    await writeProfileToMemory(flaky, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    expect(attempts).toBeGreaterThan(1);
    expect(mem.files.get('.kortix/memory/enrichment/example.com/profile.md')).toBeDefined();
  });

  test('re-reads the index between retries so a concurrent write is not clobbered', async () => {
    const mem = memoryPort();
    let attempts = 0;
    const racing: MemoryPort = {
      read: mem.port.read,
      commitMany: async (args) => {
        attempts += 1;
        if (attempts === 1) {
          await mem.port.commitMany({
            files: [
              {
                path: MEMORY_INDEX_PATH,
                content: `# Project Memory\n\n${INDEX_HEADING}\n\n- **other.com**\n  - [profile](enrichment/other.com/profile.md)\n`,
              },
            ],
            deletes: [],
            message: 'concurrent',
          });
          throw new Error('ref update failed');
        }
        return mem.port.commitMany(args);
      },
    };

    await writeProfileToMemory(racing, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    const index = mem.files.get(MEMORY_INDEX_PATH)!;
    expect(index).toContain('enrichment/other.com/profile.md');
    expect(index).toContain('enrichment/example.com/profile.md');
  });

  test('gives up after the retry budget', async () => {
    const failing: MemoryPort = {
      read: async () => null,
      commitMany: async () => {
        throw new Error('ref update failed');
      },
    };

    await expect(
      writeProfileToMemory(failing, {
        domain: 'example.com',
        profile: profile(),
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow('ref update failed');
  });
});
