/**
 * Visibility isolation — the PURE path-matching core (buildResourceDenier) that
 * the file routes (content/list/search) and the Slack picker hang off. Given a
 * member's ACCESSIBLE agent names / skill slugs, it maps the NON-accessible ones
 * to the repo file paths that must be hidden. No DB: locks the exact deny logic,
 * especially the skill-dir prefix matching (the easy place for a sibling-slug
 * collision bug).
 */
import { describe, expect, test } from 'bun:test';
import { buildResourceDenier } from '../projects/lib/project-resources';
import type { ProjectConfigSummary } from '../projects/git/types';

const CONFIG = {
  is_kortix_repo: true,
  signals: {},
  manifest_raw: null,
  manifest: {},
  env: { required: [], optional: [] },
  open_code_raw: null,
  open_code_default_agent: null,
  agent_discovery: 'declarative',
  agents: [
    { name: 'release-bot', path: 'team/agents/release-bot.md', description: null, mode: null, source: 'kortix.yaml' },
    { name: 'free-bot', path: 'team/agents/free-bot.md', description: null, mode: null, source: 'kortix.yaml' },
    // An agent with no prompt file has none to deny.
    { name: 'manifest-bot', path: 'kortix.yaml#agents.manifest-bot', description: null, mode: null, source: 'kortix.yaml' },
  ],
  skills: [
    { name: 'lead-research', path: 'team/skills/lead-research/SKILL.md', description: null },
    { name: 'open-skill', path: 'team/skills/open-skill/SKILL.md', description: null },
  ],
  commands: [],
} as unknown as ProjectConfigSummary;

describe('buildResourceDenier — nothing denied → null', () => {
  test('member can access everything → null (caller skips filtering)', () => {
    const denier = buildResourceDenier(
      CONFIG,
      new Set(['release-bot', 'free-bot', 'manifest-bot']),
      new Set(['lead-research', 'open-skill']),
    );
    expect(denier).toBeNull();
  });
});

describe('buildResourceDenier — denied agent blocks its exact file only', () => {
  // accessible = free-bot only → release-bot is denied.
  const denier = buildResourceDenier(CONFIG, new Set(['free-bot', 'manifest-bot']), new Set(['lead-research', 'open-skill']))!;

  test('the denied agent file is blocked', () => {
    expect(denier.isDenied('team/agents/release-bot.md')).toBe(true);
  });
  test('leading ./ and / are normalized', () => {
    expect(denier.isDenied('./team/agents/release-bot.md')).toBe(true);
    expect(denier.isDenied('/team/agents/release-bot.md')).toBe(true);
  });
  test('every spelling git reads as the same file is blocked (KRTX-3403)', () => {
    for (const path of [
      './/team/agents/release-bot.md',
      '././team/agents/release-bot.md',
      'team//agents/release-bot.md',
      'team/./agents/release-bot.md',
      'team/agents/release-bot.md/',
    ]) {
      expect(denier.isDenied(path)).toBe(true);
    }
  });
  test('an accessible (or unscoped) agent file is NOT blocked', () => {
    expect(denier.isDenied('team/agents/free-bot.md')).toBe(false);
  });
  test('an unrelated file is not blocked', () => {
    expect(denier.isDenied('README.md')).toBe(false);
    expect(denier.isDenied('team/agents/release-bot.md.bak')).toBe(false);
  });
});

describe('buildResourceDenier — denied skill blocks its whole directory', () => {
  // accessible = open-skill only → lead-research denied.
  const denier = buildResourceDenier(CONFIG, new Set(['release-bot', 'free-bot', 'manifest-bot']), new Set(['open-skill']))!;

  test('the SKILL.md and nested files are blocked', () => {
    expect(denier.isDenied('team/skills/lead-research/SKILL.md')).toBe(true);
    expect(denier.isDenied('team/skills/lead-research/references/notes.md')).toBe(true);
  });
  test('the bare directory path (no trailing slash) is blocked', () => {
    expect(denier.isDenied('team/skills/lead-research')).toBe(true);
  });
  test('a sibling whose slug PREFIXES the denied one is NOT caught (the collision trap)', () => {
    expect(denier.isDenied('team/skills/lead-research-v2/SKILL.md')).toBe(false);
    expect(denier.isDenied('team/skills/open-skill/SKILL.md')).toBe(false);
  });
});

describe('buildResourceDenier — containsDenied gates archives that cannot be stripped', () => {
  // release-bot agent + lead-research skill denied.
  const denier = buildResourceDenier(CONFIG, new Set(['free-bot', 'manifest-bot']), new Set(['open-skill']))!;

  test('the whole repo always includes a denied file', () => {
    expect(denier.containsDenied('')).toBe(true);
  });
  test('a parent dir that contains a denied resource is refused', () => {
    expect(denier.containsDenied('team')).toBe(true);
    expect(denier.containsDenied('team/agents')).toBe(true);
    expect(denier.containsDenied('team/skills')).toBe(true);
  });
  test('the denied subtree root itself is refused', () => {
    expect(denier.containsDenied('team/skills/lead-research')).toBe(true);
    expect(denier.containsDenied('team/agents/release-bot.md')).toBe(true);
  });
  test('a clean subtree with no denied resources is allowed', () => {
    expect(denier.containsDenied('team/skills/open-skill')).toBe(false);
    expect(denier.containsDenied('docs')).toBe(false);
  });
  test('every spelling of the root or of a parent dir is refused (KRTX-3403)', () => {
    for (const path of ['.', './', './/', './.', 'team/', 'team//', './team/.', 'team//agents']) {
      expect(denier.containsDenied(path)).toBe(true);
    }
  });
});

describe('buildResourceDenier — an agent with its own prompt file', () => {
  const declared = {
    ...CONFIG,
    agent_discovery: 'declarative',
    agents: [
      { name: 'kortix', path: 'agents/kortix.md', description: null, mode: null, source: 'kortix.yaml' },
      { name: 'hidden-bot', path: 'agents/hidden-bot.md', description: null, mode: null, source: 'kortix.yaml' },
      { name: 'inline-bot', path: 'kortix.yaml#agents.inline-bot', description: null, mode: null, source: 'kortix.yaml' },
    ],
    skills: [],
  } as unknown as ProjectConfigSummary;

  test('the denied declared agent’s file is blocked, under any spelling (KRTX-3403)', () => {
    const denier = buildResourceDenier(declared, new Set(['kortix', 'inline-bot']), new Set())!;
    expect(denier.isDenied('agents/hidden-bot.md')).toBe(true);
    expect(denier.isDenied('.//agents/hidden-bot.md')).toBe(true);
    expect(denier.isDenied('agents/kortix.md')).toBe(false);
    expect(denier.containsDenied('agents')).toBe(true);
  });
  test('a respelled declared file path is denied as the file git reads (Strix review 2)', () => {
    const respelled = {
      ...declared,
      agents: [
        ...declared.agents,
        { name: 'odd-bot', path: './agents//odd-bot.md/', description: null, mode: null, source: 'kortix.yaml' },
      ],
    } as unknown as ProjectConfigSummary;
    const denier = buildResourceDenier(respelled, new Set(['kortix', 'hidden-bot', 'inline-bot']), new Set())!;
    expect(denier.isDenied('agents/odd-bot.md')).toBe(true);
  });
  test('a hidden agent\'s prompt file is denied like any other (FILE-15)', () => {
    const withHidden = {
      ...declared,
      agents: [
        ...declared.agents,
        { name: 'internal', path: 'agents/internal.md', description: null, mode: null, hidden: true, source: 'kortix.yaml' },
      ],
    } as unknown as ProjectConfigSummary;
    const denier = buildResourceDenier(withHidden, new Set(['kortix', 'hidden-bot', 'inline-bot']), new Set())!;
    expect(denier.isDenied('agents/internal.md')).toBe(true);
  });
  test('a denied declared agent with no file of its own leaves the shared manifest readable', () => {
    expect(buildResourceDenier(declared, new Set(['kortix', 'hidden-bot']), new Set())).toBeNull();
  });
});

describe('buildResourceDenier — an agent without a prompt file never yields a deny path', () => {
  test('a denied manifest agent does not block any file (only the shared manifest holds it)', () => {
    // manifest-bot NOT accessible, but it has no own file → no deny path → null
    // (the other resources are all accessible).
    const denier = buildResourceDenier(
      CONFIG,
      new Set(['release-bot', 'free-bot']),
      new Set(['lead-research', 'open-skill']),
    );
    expect(denier).toBeNull();
  });
});
