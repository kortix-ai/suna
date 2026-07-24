import { describe, expect, test } from 'bun:test';
import type { CompanyProfile, ProfileProvenance } from '../schemas';
import {
  INDEX_HEADING,
  MEMORY_INDEX_PATH,
  profileRepoPath,
  renderProfileMarkdown,
  upsertIndexLine,
  writeProfileToMemory,
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

function memoryPort(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const commits: Array<{ path: string; message: string }> = [];
  const port: MemoryPort = {
    read: async (path) => files.get(path) ?? null,
    commit: async (path, content, message) => {
      commits.push({ path, message });
      files.set(path, content);
    },
  };
  return { port, files, commits };
}

describe('profileRepoPath', () => {
  test('places the profile in the enrichment subdirectory', () => {
    expect(profileRepoPath('example.com')).toBe('.kortix/memory/enrichment/example.com.md');
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

describe('upsertIndexLine', () => {
  test('creates the section when the index has none', () => {
    const result = upsertIndexLine('# Project Memory\n\nSome preamble.\n', 'example.com', profile());
    expect(result).toContain(INDEX_HEADING);
    expect(result).toContain('[Example Inc](enrichment/example.com.md)');
  });

  test('preserves existing index content', () => {
    const result = upsertIndexLine('# Project Memory\n\nSome preamble.\n', 'example.com', profile());
    expect(result).toContain('Some preamble.');
  });

  test('appends into an existing section', () => {
    const existing = `# Project Memory\n\n${INDEX_HEADING}\n\n- [Other](enrichment/other.com.md) — other\n`;
    const result = upsertIndexLine(existing, 'example.com', profile());
    expect(result).toContain('enrichment/other.com.md');
    expect(result).toContain('enrichment/example.com.md');
  });

  test('replaces the line for a domain already indexed', () => {
    const existing = `# Project Memory\n\n${INDEX_HEADING}\n\n- [Stale name](enrichment/example.com.md) — old summary\n`;
    const result = upsertIndexLine(existing, 'example.com', profile());

    expect(result).not.toContain('Stale name');
    expect(result).not.toContain('old summary');
    expect(result.match(/enrichment\/example\.com\.md/g)).toHaveLength(1);
  });

  test('is stable when applied twice', () => {
    const once = upsertIndexLine(null, 'example.com', profile());
    const twice = upsertIndexLine(once, 'example.com', profile());
    expect(twice).toBe(once);
  });

  test('handles a missing index file', () => {
    const result = upsertIndexLine(null, 'example.com', profile());
    expect(result).toContain('[Example Inc](enrichment/example.com.md)');
  });

  test('falls back to the domain as the label', () => {
    const result = upsertIndexLine(null, 'example.com', profile({ name: null, tagline: null, description: null }));
    expect(result).toContain('[example.com](enrichment/example.com.md)');
  });

  test('truncates a long summary', () => {
    const long = 'x'.repeat(400);
    const result = upsertIndexLine(null, 'example.com', profile({ tagline: long }));
    const line = result.split('\n').find((l) => l.includes('enrichment/example.com.md'))!;
    expect(line.length).toBeLessThan(200);
    expect(line).toContain('...');
  });
});

describe('writeProfileToMemory', () => {
  test('writes the profile file and the index', async () => {
    const mem = memoryPort();
    const result = await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    expect(result.profilePath).toBe('.kortix/memory/enrichment/example.com.md');
    expect(mem.files.get(result.profilePath)).toContain('# Example Inc');
    expect(mem.files.get(MEMORY_INDEX_PATH)).toContain('enrichment/example.com.md');
  });

  test('commits the profile before the index', async () => {
    const mem = memoryPort();
    await writeProfileToMemory(mem.port, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    expect(mem.commits[0].path).toBe('.kortix/memory/enrichment/example.com.md');
    expect(mem.commits[1].path).toBe(MEMORY_INDEX_PATH);
  });

  test('replaces the profile on re-enrichment without duplicating the index line', async () => {
    const mem = memoryPort();
    const args = { domain: 'example.com', profile: profile(), provenance: PROVENANCE };
    await writeProfileToMemory(mem.port, args);
    await writeProfileToMemory(mem.port, {
      ...args,
      profile: profile({ tagline: 'A new tagline' }),
    });

    const index = mem.files.get(MEMORY_INDEX_PATH)!;
    expect(index.match(/enrichment\/example\.com\.md/g)).toHaveLength(1);
    expect(index).toContain('A new tagline');
  });

  test('retries a commit that loses the compare-and-swap race', async () => {
    const mem = memoryPort();
    let attempts = 0;
    const flaky: MemoryPort = {
      read: mem.port.read,
      commit: async (path, content, message) => {
        attempts += 1;
        if (attempts === 1) throw new Error('ref update failed');
        return mem.port.commit(path, content, message);
      },
    };

    await writeProfileToMemory(flaky, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    expect(attempts).toBeGreaterThan(1);
    expect(mem.files.get('.kortix/memory/enrichment/example.com.md')).toBeDefined();
  });

  test('re-reads the index between retries so a concurrent write is not clobbered', async () => {
    const mem = memoryPort();
    let indexCommits = 0;
    const racing: MemoryPort = {
      read: mem.port.read,
      commit: async (path, content, message) => {
        if (path === MEMORY_INDEX_PATH) {
          indexCommits += 1;
          if (indexCommits === 1) {
            // Another writer lands first, then our commit is rejected.
            await mem.port.commit(
              path,
              `# Project Memory\n\n${INDEX_HEADING}\n\n- [Other](enrichment/other.com.md) — other\n`,
              'concurrent',
            );
            throw new Error('ref update failed');
          }
        }
        return mem.port.commit(path, content, message);
      },
    };

    await writeProfileToMemory(racing, {
      domain: 'example.com',
      profile: profile(),
      provenance: PROVENANCE,
    });

    const index = mem.files.get(MEMORY_INDEX_PATH)!;
    expect(index).toContain('enrichment/other.com.md');
    expect(index).toContain('enrichment/example.com.md');
  });

  test('gives up after the retry budget', async () => {
    const failing: MemoryPort = {
      read: async () => null,
      commit: async () => {
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
