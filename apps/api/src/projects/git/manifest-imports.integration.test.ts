import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ManifestImportError, parseManifestText } from '@kortix/manifest-schema';
import {
  commitManifest,
  removeTriggerFromManifest,
  upsertTriggerInManifest,
} from '../lib/triggers';
import { extractTriggers, loadProjectTriggers, readManifest } from '../triggers';
import { loadProjectConfig } from './config';
import type { GitBackedProject } from './types';

const exec = promisify(execFile);

let testRoot = '';
let remotePath = '';
let seedPath = '';
let project: GitBackedProject;
type ManifestProject = Parameters<typeof commitManifest>[0];

async function git(args: string[], cwd?: string): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

/** Text of one file at the remote's `main`, or null when it does not exist. */
async function remoteFile(path: string): Promise<string | null> {
  // Untrimmed: byte-for-byte comparisons below must see the trailing newline.
  return exec('git', ['--git-dir', remotePath, 'show', `main:${path}`]).then(
    (result) => result.stdout,
    () => null,
  );
}

async function remoteFilesChangedByHead(): Promise<string[]> {
  const out = await git(['--git-dir', remotePath, 'show', '--name-only', '--format=', 'main']);
  return out.split('\n').filter(Boolean).sort();
}

/** Commit files straight to the remote, as a user pushing from their laptop. */
async function push(files: Record<string, string>, message: string): Promise<void> {
  await git(['pull', '--quiet', 'origin', 'main'], seedPath).catch(() => undefined);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(seedPath, path)), { recursive: true });
    await writeFile(join(seedPath, path), content);
  }
  await git(['add', '-A'], seedPath);
  await git(['commit', '-m', message], seedPath);
  await git(['push', 'origin', 'main'], seedPath);
}

const ROOT = `# Acme — root manifest
kortix_version: 2
default_agent: kortix
imports:
  - .kortix/triggers/
  - .kortix/agents.yaml
agents:
  kortix:
    connectors: all
triggers:
  - slug: root-trigger
    type: cron
    cron: "0 9 * * *"
    prompt: from the root file
`;

const SEED = {
  'kortix.yaml': ROOT,
  '.kortix/agents.yaml': 'agents:\n  galileo:\n    connectors: none\n',
  '.kortix/triggers/reports/weekly.yaml': `triggers:
  - slug: weekly-report
    type: cron
    cron: "0 15 * * 0"
    agent: galileo
    prompt: |-
      SUNDAY RETRY RUN for the Cross-Sector Weekly Report.

      STEP 1 - check sent items.
`,
  '.kortix/triggers/dockets.yaml': `triggers:
  - slug: docket-monitor
    type: cron
    cron: "0 9 * * 1-5"
    prompt: check the docket
`,
};

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-manifest-imports-'));
  remotePath = join(testRoot, 'remote.git');
  seedPath = join(testRoot, 'seed');
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', seedPath]);
  await git(['config', 'user.name', 'Kortix Test'], seedPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], seedPath);
  await git(['remote', 'add', 'origin', remotePath], seedPath);
  await push(SEED, 'seed split manifest');
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `manifest-imports-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('kortix.yaml imports over a real git repository', () => {
  test('read: merges every imported file and reports the declaring file per trigger', async () => {
    const manifest = await readManifest(project);
    if (!manifest) throw new Error('Expected the seeded manifest');
    expect(manifest.path).toBe('kortix.yaml');
    expect(Object.keys(manifest.raw.agents as object)).toEqual(['kortix', 'galileo']);

    const { specs, errors } = extractTriggers(manifest);
    expect(errors).toEqual([]);
    // `extractTriggers` returns specs sorted by slug.
    expect(specs.map((s) => [s.slug, s.path])).toEqual([
      ['docket-monitor', '.kortix/triggers/dockets.yaml#triggers.docket-monitor'],
      ['root-trigger', 'kortix.yaml#triggers.root-trigger'],
      ['weekly-report', '.kortix/triggers/reports/weekly.yaml#triggers.weekly-report'],
    ]);
    expect(specs[2]?.agent).toBe('galileo');
    expect(specs[2]?.promptTemplate).toContain('STEP 1 - check sent items.');
  });

  test('read: the project config summary sees imported agents; manifest_raw stays the root text', async () => {
    const config = await loadProjectConfig(project);
    expect(config.manifest_raw).toBe(ROOT);
    expect(config.manifest_version).toMatchObject({ version: 2 });
  });

  test('write: editing an imported trigger commits ONLY the file that declares it', async () => {
    const manifest = await readManifest(project, { forceRefresh: true });
    if (!manifest) throw new Error('Expected the seeded manifest');
    const spec = extractTriggers(manifest).specs.find((s) => s.slug === 'weekly-report');
    if (!spec) throw new Error('Expected weekly-report');

    const edited = upsertTriggerInManifest(manifest, { ...spec, enabled: false });
    expect(await commitManifest(project as ManifestProject, edited, 'disable weekly')).toEqual({
      ok: true,
    });

    expect(await remoteFilesChangedByHead()).toEqual(['.kortix/triggers/reports/weekly.yaml']);
    // The root is untouched byte-for-byte — comment included, nothing flattened into it.
    expect(await remoteFile('kortix.yaml')).toBe(ROOT);
    const weekly = parseManifestText(
      (await remoteFile('.kortix/triggers/reports/weekly.yaml')) ?? '',
      'yaml',
    );
    expect((weekly.triggers as Array<Record<string, unknown>>)[0]?.enabled).toBe(false);

    // Read-back through the platform: still three triggers, no duplicates.
    const reread = await loadProjectTriggers(project, { forceRefresh: true });
    expect(reread.errors).toEqual([]);
    expect(reread.specs.map((s) => s.slug).sort()).toEqual([
      'docket-monitor',
      'root-trigger',
      'weekly-report',
    ]);
    expect(reread.specs.find((s) => s.slug === 'weekly-report')?.enabled).toBe(false);
  });

  test('write: a new trigger lands in the root; deleting an imported one edits its own file', async () => {
    const manifest = await readManifest(project, { forceRefresh: true });
    if (!manifest) throw new Error('Expected the seeded manifest');
    const template = extractTriggers(manifest).specs.find((s) => s.slug === 'root-trigger');
    if (!template) throw new Error('Expected root-trigger');

    let edited = upsertTriggerInManifest(manifest, { ...template, slug: 'brand-new', name: 'New' });
    edited = removeTriggerFromManifest(edited, 'docket-monitor');
    expect(await commitManifest(project as ManifestProject, edited, 'add + delete')).toEqual({
      ok: true,
    });

    expect(await remoteFilesChangedByHead()).toEqual([
      '.kortix/triggers/dockets.yaml',
      'kortix.yaml',
    ]);
    const root = parseManifestText((await remoteFile('kortix.yaml')) ?? '', 'yaml');
    expect((root.triggers as Array<{ slug: string }>).map((t) => t.slug)).toEqual([
      'root-trigger',
      'brand-new',
    ]);
    expect(root.imports).toEqual(['.kortix/triggers/', '.kortix/agents.yaml']);
    // The emptied imported file keeps its key rather than collapsing to `{}`.
    expect(await remoteFile('.kortix/triggers/dockets.yaml')).toBe('triggers: []\n');
    expect(root.agents).toEqual({ kortix: { connectors: 'all' } });

    const reread = await loadProjectTriggers(project, { forceRefresh: true });
    expect(reread.errors).toEqual([]);
    expect(reread.specs.map((s) => s.slug).sort()).toEqual([
      'brand-new',
      'root-trigger',
      'weekly-report',
    ]);
  });

  test('write: a concurrent push to ANY imported file rejects the stale edit with 409', async () => {
    const stale = await readManifest(project, { forceRefresh: true });
    if (!stale) throw new Error('Expected the seeded manifest');
    const spec = extractTriggers(stale).specs.find((s) => s.slug === 'weekly-report');
    if (!spec) throw new Error('Expected weekly-report');

    // Someone pushes a change to a DIFFERENT imported file in the meantime.
    await push(
      {
        '.kortix/triggers/dockets.yaml':
          'triggers:\n  - slug: docket-monitor\n    type: cron\n    cron: "0 8 * * *"\n    prompt: changed\n',
      },
      'concurrent push',
    );

    const edited = upsertTriggerInManifest(stale, { ...spec, enabled: false });
    expect(await commitManifest(project as ManifestProject, edited, 'stale write')).toEqual({
      error: 'File ".kortix/triggers/dockets.yaml" changed since it was read',
      status: 409,
    });
    expect(await remoteFile('.kortix/triggers/reports/weekly.yaml')).toBe(
      SEED['.kortix/triggers/reports/weekly.yaml'],
    );
  });

  test('a broken import is an error, never an absent manifest', async () => {
    await push(
      {
        '.kortix/triggers/clash.yaml':
          'triggers:\n  - slug: root-trigger\n    type: cron\n    cron: "* * * * *"\n    prompt: dup\n',
      },
      'introduce a duplicate slug',
    );

    const error = await readManifest(project, { forceRefresh: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ManifestImportError);
    expect((error as Error).message).toBe(
      'triggers "root-trigger" is declared in both kortix.yaml and .kortix/triggers/clash.yaml — one name, one file',
    );

    // The Triggers page gets the message instead of an empty list.
    const listed = await loadProjectTriggers(project, { forceRefresh: true });
    expect(listed.specs).toEqual([]);
    expect(listed.errors[0]?.error).toContain('declared in both kortix.yaml and');

    // The config summary degrades to the root file instead of reporting "no manifest".
    const config = await loadProjectConfig(project);
    expect(config.signals.manifest).toBe(true);
    expect(config.manifest_raw).toBe(ROOT);
  });
});
