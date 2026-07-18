import { describe, expect, mock, test } from 'bun:test';
import { parseManifestText, validateManifest } from '@kortix/manifest-schema';

// `loadManifestForEdit`'s only I/O is git: `readManifest` (imported from
// `../triggers`) calls `readManifestFromRepo` — resolved from `../git`
// relative to THIS file, the same absolute module `../triggers.ts` itself
// resolves `./git` to. `withProjectGitAuth` is `./git` relative to this file,
// the same module `../lib/triggers.ts` imports it from. Mocking both lets the
// synthesis path (no manifest committed yet) run with zero DB/network, same
// pattern as `./compile-agent-config.test.ts`.
let manifestFile: { path: string; content: string } | null = null;

// `../git` and `./git` are heavily-imported modules (session-lifecycle,
// github, etc. all pull other exports off them) — spread the REAL module and
// override only `readManifestFromRepo`/`withProjectGitAuth`, rather than
// replacing the whole module, so unrelated named exports the rest of
// `lib/triggers.ts`'s import graph needs stay intact.
const realProjectsGit = await import('../git');
mock.module('../git', () => ({
  ...realProjectsGit,
  readManifestFromRepo: async () => manifestFile,
}));

const realLibGit = await import('./git');
mock.module('./git', () => ({
  ...realLibGit,
  withProjectGitAuth: async (project: unknown) => ({
    ...(project as Record<string, unknown>),
    gitAuthToken: null,
  }),
}));

const { loadManifestForEdit } = await import('./triggers');
const { serializeManifest } = await import('../triggers');
const { DEFAULT_AGENT_SENTINEL, extractAgents, resolveGovernedAgentGrant } = await import(
  '../agents'
);

const fakeProject = (overrides: Record<string, unknown> = {}) =>
  ({
    projectId: 'proj_blank',
    name: 'blank-project',
    manifestPath: 'kortix.toml',
    defaultBranch: 'main',
    metadata: { require_declared_agents: true },
    ...overrides,
  }) as unknown as Parameters<typeof loadManifestForEdit>[0];

describe('loadManifestForEdit — blank managed project (no kortix.yaml on disk yet)', () => {
  test('synthesizes a valid v2 manifest with a declared, resolvable default agent', async () => {
    manifestFile = null; // "brand-new repo" — nothing committed yet

    const manifest = await loadManifestForEdit(fakeProject());

    // The bug: this used to synthesize schemaVersion 1 (KNOWN_SCHEMA_VERSION),
    // which the v2-only agent-config writers (applyAgentBlockV2 /
    // applyDefaultAgentV2) hard-refuse — every write 400'd before a real
    // manifest could ever land in git, so the project was permanently stuck
    // un-declarable.
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.format).toBe('yaml');

    const defaultAgent = manifest.raw.default_agent;
    expect(typeof defaultAgent).toBe('string');
    expect((defaultAgent as string).length).toBeGreaterThan(0);

    const agents = manifest.raw.agents as Record<string, unknown> | undefined;
    expect(agents).toBeTruthy();
    expect(agents?.[defaultAgent as string]).toBeTruthy();

    // Prove it end-to-end through the same serialize → re-parse → validate
    // pipeline `commitManifest` actually runs (not just shape-poking the
    // in-memory `raw`, which omits `kortix_version` by construction — see
    // `serializeManifest`'s doc comment): a v2 manifest must declare >=1
    // agent AND a default_agent that resolves to one of them
    // (validateAgentsV2 / validateDefaultAgentV2) — exactly the two facts
    // the declared-agent session-create check needs.
    const committedText = serializeManifest(manifest);
    const reparsed = parseManifestText(committedText, manifest.format);
    const result = validateManifest(reparsed, manifest.format);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    expect(errors).toEqual([]);

    // Close the loop all the way to the actual session-create gate: the
    // 'default' sentinel must resolve to a real, enabled grant — never
    // AGENT_NOT_DECLARED — the moment this manifest exists, with zero writes.
    const loadedAgents = extractAgents(manifest);
    const governed = resolveGovernedAgentGrant(DEFAULT_AGENT_SENTINEL, loadedAgents, {
      subject: true,
      projectDefaultAgent: null,
    });
    expect(governed.ok).toBe(true);
  });

  test('an already-committed manifest is read as-is, untouched (v1 stays v1)', async () => {
    manifestFile = {
      path: 'kortix.toml',
      content: 'kortix_version = 1\n\n[project]\nname = "legacy"\n',
    };

    const manifest = await loadManifestForEdit(fakeProject({ metadata: {} }));

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.format).toBe('toml');
    expect(manifest.raw.agents).toBeUndefined();
  });
});
