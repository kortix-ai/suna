/**
 * Characterization pins for `denierFromConfig` (KRTX-1499).
 *
 * Only the PURE core (`buildResourceDenier`, `unit-resource-denier.test.ts`)
 * was pinned before; the DB-backed wrapper that maps a loaded config to agent
 * names / skill slugs, resolves the actor and runs the two
 * `filterAccessibleObjects` reads had no test. KRTX-1499 extracts that block
 * into one helper, so these pins capture the wrapper's contract first: the id
 * mapping (agent → `name`, skill → directory slug), the actor read from the
 * request context, the per-type accessible sets, and the denier they build.
 * The IAM collaborators are stubbed with `mock.module` — this pins the
 * wrapper's wiring, not the engine.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProjectConfigSummary } from '../git/types';
import * as realIam from '../../iam';
import * as realActor from '../../iam/actor';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TOKEN = 'tok-1';

type FilterCall = { actorId: string; projectId: string; type: string; ids: string[] };
let accessibleByType: Record<string, string[]> = {};
const actorCalls: Array<{ userId: string; accountId: string; tokenId: string | undefined }> = [];
const filterCalls: FilterCall[] = [];

// Spread the real modules: `mock.module` replaces them WHOLESALE, so a stub
// that omits a name breaks every other importer in this file's graph
// (scope-push.test.ts idiom).
mock.module('../../iam', () => ({
  ...realIam,
  filterAccessibleObjects: async (
    actor: { userId: string },
    projectId: string,
    type: string,
    ids: string[],
  ) => {
    filterCalls.push({ actorId: actor.userId, projectId, type, ids: [...ids] });
    return accessibleByType[type] ?? [];
  },
  hasAnyResourceGrants: async () => true,
}));
mock.module('../../iam/actor', () => ({
  ...realActor,
  actorForToken: async (userId: string, accountId: string, tokenId?: string) => {
    actorCalls.push({ userId, accountId, tokenId });
    return { userId, accountId, credential: { kind: 'jwt' } };
  },
}));

const { denierFromConfig } = await import('./project-resources');

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
    // A kortix.yaml (manifest-declared) agent has no separate file — never produces a deny path.
    { name: 'manifest-bot', path: '(manifest)', description: null, mode: null, source: 'kortix.yaml' },
  ],
  skills: [
    { name: 'Lead Research', path: '.opencode/skills/lead-research/SKILL.md', description: null },
    { name: 'Open Skill', path: '.opencode/skills/open-skill/SKILL.md', description: null },
  ],
  commands: [],
} as unknown as ProjectConfigSummary;

const CTX = { userId: USER, accountId: ACCOUNT, projectId: PROJECT, actingTokenId: TOKEN };

beforeEach(() => {
  accessibleByType = {};
  actorCalls.length = 0;
  filterCalls.length = 0;
});

describe('denierFromConfig — the DB-backed wrapper', () => {
  test('resolves the actor from the context and filters each resource type once', async () => {
    accessibleByType = { agent: ['release-bot', 'free-bot', 'manifest-bot'], skill: ['lead-research', 'open-skill'] };
    await denierFromConfig(CONFIG, CTX);
    expect(actorCalls).toEqual([{ userId: USER, accountId: ACCOUNT, tokenId: TOKEN }]);
    expect(filterCalls).toEqual([
      { actorId: USER, projectId: PROJECT, type: 'agent', ids: ['release-bot', 'free-bot', 'manifest-bot'] },
      // Skills map to their directory slug, never the display name.
      { actorId: USER, projectId: PROJECT, type: 'skill', ids: ['lead-research', 'open-skill'] },
    ]);
  });

  test('everything accessible → null (the caller skips filtering)', async () => {
    accessibleByType = { agent: ['release-bot', 'free-bot', 'manifest-bot'], skill: ['lead-research', 'open-skill'] };
    expect(await denierFromConfig(CONFIG, CTX)).toBeNull();
  });

  test('denies the files of the agents/skills the member cannot access', async () => {
    accessibleByType = { agent: ['free-bot'], skill: ['open-skill'] };
    const denier = await denierFromConfig(CONFIG, CTX);
    expect(denier).not.toBeNull();
    expect(denier!.denied).toEqual([
      '.opencode/agent/release-bot.md',
      // The whole skill directory, matched with a trailing slash.
      '.opencode/skills/lead-research/',
    ]);
    expect(denier!.isDenied('.opencode/agent/release-bot.md')).toBe(true);
    expect(denier!.isDenied('.opencode/agent/free-bot.md')).toBe(false);
    expect(denier!.isDenied('.opencode/skills/lead-research/SKILL.md')).toBe(true);
    expect(denier!.isDenied('.opencode/skills/open-skill/SKILL.md')).toBe(false);
    // The manifest agent is not a file, so it never denies a path.
    expect(denier!.isDenied('kortix.yaml')).toBe(false);
  });

  test('a subtree containing a denied resource is refused', async () => {
    accessibleByType = { agent: ['free-bot', 'manifest-bot'], skill: ['open-skill'] };
    const denier = await denierFromConfig(CONFIG, CTX);
    expect(denier!.containsDenied('.opencode/agent')).toBe(true);
    expect(denier!.containsDenied('.opencode/skills/lead-research')).toBe(true);
    expect(denier!.containsDenied('.opencode/skills/open-skill')).toBe(false);
    expect(denier!.containsDenied('')).toBe(true);
  });
});
