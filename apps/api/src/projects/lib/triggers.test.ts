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
let manifestReader:
  | ((...args: unknown[]) => Promise<{ path: string; content: string } | null>)
  | null = null;

// `../git` and `./git` are heavily-imported modules (session-lifecycle,
// github, etc. all pull other exports off them) — spread the REAL module and
// override only `readManifestFromRepo`/`withProjectGitAuth`, rather than
// replacing the whole module, so unrelated named exports the rest of
// `lib/triggers.ts`'s import graph needs stay intact.
const realProjectsGit = await import('../git');
mock.module('../git', () => ({
  ...realProjectsGit,
  readManifestFromRepo: async (...args: unknown[]) =>
    manifestReader ? manifestReader(...args) : manifestFile,
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
const { parseManifestString, serializeManifest } = await import('../triggers');
const { findProjectTriggerBySlug } = await import('../triggers');
const { DEFAULT_AGENT_SENTINEL, extractAgents, resolveGovernedAgentGrant, loadProjectAgents } =
  await import('../agents');
const { applyDefaultAgentV2, applyAgentBlockV2 } = await import('./agent-config-v2');

const fakeProject = (overrides: Record<string, unknown> = {}) =>
  ({
    projectId: 'proj_blank',
    name: 'blank-project',
    manifestPath: 'kortix.yaml',
    defaultBranch: 'main',
    metadata: { require_declared_agents: true },
    ...overrides,
  }) as unknown as Parameters<typeof loadManifestForEdit>[0];

describe('loadManifestForEdit — blank managed project (no kortix.yaml on disk yet)', () => {
  test('synthesizes a valid manifest with a declared, resolvable default agent', async () => {
    manifestFile = null; // "brand-new repo" — nothing committed yet

    const manifest = await loadManifestForEdit(fakeProject());
    expect(manifest.path).toBe('kortix.yaml');

    const defaultAgent = manifest.raw.default_agent;
    expect(typeof defaultAgent).toBe('string');
    expect((defaultAgent as string).length).toBeGreaterThan(0);

    const agents = manifest.raw.agents as Record<string, unknown> | undefined;
    expect(agents).toBeTruthy();
    expect(agents?.[defaultAgent as string]).toBeTruthy();

    // The manifest has no version: nothing writes `kortix_version`.
    expect(manifest.raw.kortix_version).toBeUndefined();

    // Also prove it end-to-end through the serialize → re-parse → validate
    // pipeline `commitManifest` runs once the manifest is actually committed:
    // the default_agent resolves to a declared agent, the fact the
    // declared-agent session-create check needs.
    const committedText = serializeManifest(manifest);
    expect(committedText).not.toContain('kortix_version');
    const reparsed = parseManifestText(committedText);
    const result = validateManifest(reparsed);
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

  // GAP 1 (dev-live repro): #4974 only patched THIS function
  // (`loadManifestForEdit`), which backs the agent-config EDIT endpoints.
  // Session-create resolves the declared agent through a DIFFERENT function
  // — `loadProjectAgents` (../agents.ts) → `readManifest` (../triggers.ts) —
  // which returned a literal `null` for the exact same "no manifest
  // committed yet" repo state this test mocks, so the fix never reached the
  // session-create gate. Same mock (`readManifestFromRepo` → null), same
  // subject/projectDefaultAgent shape sessions.ts actually passes.
  test('gap 1: loadProjectAgents (the session-create read path) resolves the same way, given the same "no manifest" repo', async () => {
    manifestFile = null;

    const loaded = await loadProjectAgents({
      projectId: 'proj_blank',
      repoUrl: 'https://github.com/acme/blank.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: null,
    });
    const governed = resolveGovernedAgentGrant(DEFAULT_AGENT_SENTINEL, loaded, {
      subject: true,
      projectDefaultAgent: null,
    });
    expect(governed.ok).toBe(true);
    if (!governed.ok) return;
    expect(governed.grant).toEqual({
      agent: 'worker',
      connectors: 'all',
      permissions: 'all',
      env: 'all',
    });
  });

  // GAP 2 (dev-live repro): `applyDefaultAgentV2`/`applyAgentBlockV2` validate
  // `manifest.raw` DIRECTLY, never through `serializeManifest`/re-parse. Runs
  // the actual write functions PUT /default-agent and PUT /agents/:name/config
  // call, against the actual object `loadManifestForEdit` hands them for a
  // blank project.
  test('gap 2: applyDefaultAgentV2 and applyAgentBlockV2 both validate the raw manifest loadManifestForEdit hands them', async () => {
    manifestFile = null;

    const manifest = await loadManifestForEdit(fakeProject());

    const defaultAgentWrite = applyDefaultAgentV2(manifest, 'worker');
    expect(defaultAgentWrite.ok).toBe(true);

    const blockWrite = applyAgentBlockV2(manifest, 'release-bot', {
      connectors: ['github'],
      kortix_permissions: ['project.cr.open'],
    });
    expect(blockWrite.ok).toBe(true);
    if (!blockWrite.ok) return;
    expect(Object.keys(blockWrite.raw.agents as Record<string, unknown>).sort()).toEqual([
      'release-bot',
      'worker',
    ]);
  });

  test('an already-committed manifest is read as-is, untouched', async () => {
    manifestFile = { path: 'kortix.yml', content: 'project:\n  name: existing\n' };

    const manifest = await loadManifestForEdit(fakeProject({ metadata: {} }));

    expect(manifest.path).toBe('kortix.yml');
    expect(manifest.raw).toEqual({ project: { name: 'existing' } });
  });
});

describe('serializeManifest — the obsolete kortix_version line', () => {
  test('a trigger write drops `kortix_version: 3` and keeps the comments', () => {
    const manifest = parseManifestString(
      [
        '# Project manifest: keep this comment.',
        'kortix_version: 3',
        'project:',
        '  name: existing',
        'triggers:',
        '  # The nightly report.',
        '  - slug: nightly',
        '    type: cron',
        '    cron: "0 0 3 * * *"',
        '    prompt: Report status',
        '',
      ].join('\n'),
    );
    const triggers = manifest.raw.triggers as Array<Record<string, unknown>>;
    manifest.raw.triggers = [...triggers, { slug: 'weekly', type: 'cron', cron: '0 0 3 * * 1', prompt: 'Weekly report' }];

    const written = serializeManifest(manifest);

    expect(written).not.toContain('kortix_version');
    expect(written).toContain('# Project manifest: keep this comment.');
    expect(written).toContain('  # The nightly report.');
    expect(parseManifestText(written)).toEqual({
      project: { name: 'existing' },
      triggers: [
        { slug: 'nightly', type: 'cron', cron: '0 0 3 * * *', prompt: 'Report status' },
        { slug: 'weekly', type: 'cron', cron: '0 0 3 * * 1', prompt: 'Weekly report' },
      ],
    });
  });
});

describe('findProjectTriggerBySlug — replica mirror convergence', () => {
  test('returns a cached trigger without forcing an unnecessary fetch', async () => {
    const forceRefreshValues: Array<boolean | undefined> = [];
    manifestReader = async (...args: unknown[]) => {
      const opts = args[3] as { forceRefresh?: boolean } | undefined;
      forceRefreshValues.push(opts?.forceRefresh);
      return {
        path: 'kortix.yaml',
        content:
          'project:\n  name: current\ntriggers:\n  - slug: daily\n    name: Daily\n    type: cron\n    cron: "0 0 3 * * *"\n    prompt: Report status\n',
      };
    };

    try {
      const trigger = await findProjectTriggerBySlug(fakeProject(), 'daily');
      expect(trigger?.slug).toBe('daily');
      expect(forceRefreshValues).toEqual([undefined]);
    } finally {
      manifestReader = null;
    }
  });

  test('forces one mirror refresh when the cached manifest does not contain the trigger', async () => {
    const forceRefreshValues: Array<boolean | undefined> = [];
    manifestReader = async (...args: unknown[]) => {
      const opts = args[3] as { forceRefresh?: boolean } | undefined;
      forceRefreshValues.push(opts?.forceRefresh);
      if (!opts?.forceRefresh) {
        return {
          path: 'kortix.yaml',
          content: 'project:\n  name: stale\ntriggers: []\n',
        };
      }
      return {
        path: 'kortix.yaml',
        content:
          'project:\n  name: fresh\ntriggers:\n  - slug: daily\n    name: Daily\n    type: cron\n    cron: "0 0 3 * * *"\n    prompt: Report status\n',
      };
    };

    try {
      const trigger = await findProjectTriggerBySlug(fakeProject(), 'daily');
      expect(trigger?.slug).toBe('daily');
      expect(forceRefreshValues).toEqual([undefined, true]);
    } finally {
      manifestReader = null;
    }
  });

  test('bounds repeated missing slugs to one forced refresh per project interval', async () => {
    const forceRefreshValues: Array<boolean | undefined> = [];
    manifestReader = async (...args: unknown[]) => {
      const opts = args[3] as { forceRefresh?: boolean } | undefined;
      forceRefreshValues.push(opts?.forceRefresh);
      return {
        path: 'kortix.yaml',
        content: 'project:\n  name: stale\ntriggers: []\n',
      };
    };

    try {
      const project = fakeProject({ projectId: 'proj_refresh_cooldown' });
      expect(await findProjectTriggerBySlug(project, 'missing-one')).toBeNull();
      expect(await findProjectTriggerBySlug(project, 'missing-two')).toBeNull();
      expect(forceRefreshValues).toEqual([undefined, true, undefined]);
    } finally {
      manifestReader = null;
    }
  });
});
