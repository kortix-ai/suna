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
  agent_discovery: 'opencode',
  agents: [
    { name: 'release-bot', path: '.opencode/agent/release-bot.md', description: null, mode: null, source: 'opencode' },
    { name: 'free-bot', path: '.opencode/agent/free-bot.md', description: null, mode: null, source: 'opencode' },
    // A kortix.toml agent has no separate file — never produces a deny path.
    { name: 'manifest-bot', path: '(manifest)', description: null, mode: null, source: 'kortix.toml' },
  ],
  skills: [
    { name: 'lead-research', path: '.opencode/skills/lead-research/SKILL.md', description: null },
    { name: 'open-skill', path: '.opencode/skills/open-skill/SKILL.md', description: null },
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
    expect(denier.isDenied('.opencode/agent/release-bot.md')).toBe(true);
  });
  test('leading ./ and / are normalized', () => {
    expect(denier.isDenied('./.opencode/agent/release-bot.md')).toBe(true);
    expect(denier.isDenied('/.opencode/agent/release-bot.md')).toBe(true);
  });
  test('an accessible (or unscoped) agent file is NOT blocked', () => {
    expect(denier.isDenied('.opencode/agent/free-bot.md')).toBe(false);
  });
  test('an unrelated file is not blocked', () => {
    expect(denier.isDenied('README.md')).toBe(false);
    expect(denier.isDenied('.opencode/agent/release-bot.md.bak')).toBe(false);
  });
});

describe('buildResourceDenier — denied skill blocks its whole directory', () => {
  // accessible = open-skill only → lead-research denied.
  const denier = buildResourceDenier(CONFIG, new Set(['release-bot', 'free-bot', 'manifest-bot']), new Set(['open-skill']))!;

  test('the SKILL.md and nested files are blocked', () => {
    expect(denier.isDenied('.opencode/skills/lead-research/SKILL.md')).toBe(true);
    expect(denier.isDenied('.opencode/skills/lead-research/references/notes.md')).toBe(true);
  });
  test('the bare directory path (no trailing slash) is blocked', () => {
    expect(denier.isDenied('.opencode/skills/lead-research')).toBe(true);
  });
  test('a sibling whose slug PREFIXES the denied one is NOT caught (the collision trap)', () => {
    expect(denier.isDenied('.opencode/skills/lead-research-v2/SKILL.md')).toBe(false);
    expect(denier.isDenied('.opencode/skills/open-skill/SKILL.md')).toBe(false);
  });
});

describe('buildResourceDenier — containsDenied gates archives that cannot be stripped', () => {
  // release-bot agent + lead-research skill denied.
  const denier = buildResourceDenier(CONFIG, new Set(['free-bot', 'manifest-bot']), new Set(['open-skill']))!;

  test('the whole repo always includes a denied file', () => {
    expect(denier.containsDenied('')).toBe(true);
  });
  test('a parent dir that contains a denied resource is refused', () => {
    expect(denier.containsDenied('.opencode')).toBe(true);
    expect(denier.containsDenied('.opencode/agent')).toBe(true);
    expect(denier.containsDenied('.opencode/skills')).toBe(true);
  });
  test('the denied subtree root itself is refused', () => {
    expect(denier.containsDenied('.opencode/skills/lead-research')).toBe(true);
    expect(denier.containsDenied('.opencode/agent/release-bot.md')).toBe(true);
  });
  test('a clean subtree with no denied resources is allowed', () => {
    expect(denier.containsDenied('.opencode/skills/open-skill')).toBe(false);
    expect(denier.containsDenied('docs')).toBe(false);
  });
});

describe('buildResourceDenier — kortix.toml agents never yield a deny path', () => {
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
