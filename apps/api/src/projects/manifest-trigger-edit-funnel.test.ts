import { describe, expect, mock, test } from 'bun:test';

// The PATCH/POST/DELETE trigger routes read the manifest through
// `loadManifestForEdit` (mutateManifestWithRetry reloads it per attempt) and
// commit through `manifestWrites`. The git layer is the funnel's only I/O —
// mock it (same spread-the-real-module pattern as ./lib/triggers.test.ts, and
// the same absolute module both consumers resolve) and drive the REAL read →
// mutate → write funnel against a commented manifest. KRTX-2742: the write
// must keep every comment instead of reserializing the file.
let manifestFile: { path: string; content: string } | null = null;

const realProjectsGit = await import('./git');
mock.module('./git', () => ({
  ...realProjectsGit,
  readManifestFromRepo: async () => manifestFile,
}));

// withProjectGitAuth (lib/git.ts) resolves the project's git credential from
// the DB; the funnel test hands the project row straight through.
const realLibGit = await import('./lib/git');
mock.module('./lib/git', () => ({
  ...realLibGit,
  withProjectGitAuth: async (project: unknown) => ({
    ...(project as Record<string, unknown>),
    gitAuthToken: null,
  }),
}));

const { loadManifestForEdit } = await import('./lib/trigger-manifest');
const { manifestWrites } = await import('./manifest-io');
const { draftToSpec, parseTriggerDraft, specToBody } = await import('./lib/trigger-draft');
const { extractTriggers } = await import('./trigger-entry');
const { removeTriggerFromManifest, upsertTriggerInManifest } = await import(
  './lib/trigger-manifest'
);

const COMMENTED_MANIFEST = `# Kortix manifest — the comments carry the reasons behind each grant.
kortix_version: 3

project:
  name: probe

default_agent: kortix

# Nightly automation.
triggers:
  # Runs the deploy audit at night.
  - slug: nightly-audit
    name: Nightly audit
    type: cron
    agent: kortix
    enabled: true
    cron: "0 3 * * *"
    prompt: Run the deploy audit and post a summary.
`;

const fakeProject = {
  projectId: 'proj_comments',
  name: 'probe',
  manifestPath: 'kortix.yaml',
  defaultBranch: 'main',
  metadata: {},
} as unknown as Parameters<typeof loadManifestForEdit>[0];

describe('trigger edit funnel: real read (loadManifestForEdit) → comment-preserving write', () => {
  test('disabling a trigger through the route funnel keeps every comment', async () => {
    manifestFile = { path: 'kortix.yaml', content: COMMENTED_MANIFEST };

    const result = await (async () => {
      // The exact body of the PATCH /triggers/:slug mutate closure, minus
      // HTTP/db (identical to routes/triggers.ts's mutateManifestWithRetry
      // callback).
      const manifest = await loadManifestForEdit(fakeProject);
      const current = extractTriggers(manifest).specs.find((s) => s.slug === 'nightly-audit');
      if (!current) throw new Error('fixture trigger missing');
      const draft = parseTriggerDraft(
        { ...specToBody(current), enabled: false },
        { existingSlug: 'nightly-audit' },
      );
      if ('error' in draft) throw new Error(draft.error);
      const next = upsertTriggerInManifest(manifest, draftToSpec(draft, manifest.path));
      manifest.raw = next.raw;
      return manifest;
    })();

    const committed = manifestWrites(result, 'kortix.yaml').files[0]?.content ?? '';
    expect(committed).toContain('# Kortix manifest — the comments carry the reasons');
    expect(committed).toContain('# Runs the deploy audit at night.');
    expect(committed).toContain('enabled: false');
    expect(committed.split('\n').filter((l) => l.trimStart().startsWith('#')).length).toBe(
      COMMENTED_MANIFEST.split('\n').filter((l) => l.trimStart().startsWith('#')).length,
    );
  });

  test('removing the last trigger through the funnel still parses and validates', async () => {
    manifestFile = { path: 'kortix.yaml', content: COMMENTED_MANIFEST };

    const manifest = await loadManifestForEdit(fakeProject);
    const next = removeTriggerFromManifest(manifest, 'nightly-audit');
    manifest.raw = next.raw;
    const committed = manifestWrites(manifest, 'kortix.yaml').files[0]?.content ?? '';

    expect(committed).toContain('triggers: []');
    expect(committed).not.toContain('nightly-audit');
    expect(committed).toContain('# Kortix manifest — the comments carry the reasons');
    // The committed text must still parse (bun's yaml parse throws on garbage).
    const { parse: parseYaml } = await import('yaml');
    expect((parseYaml(committed) as { triggers: unknown[] }).triggers).toEqual([]);
  });
});
