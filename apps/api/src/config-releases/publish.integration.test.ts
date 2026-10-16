/**
 * Published releases against a real PostgreSQL: a publish writes the
 * descriptor to the store, the head row and the ledger row once per tip; an
 * older tip never replaces a newer one; and session create hands out signed
 * URLs only when the row answers exactly as the descriptor route would.
 * Git is a recorded fake: the release and the roster are injected.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { accounts, configReleaseHeads, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import type { ConfigRelease } from './builder';
import { configReleaseEnvForSession, publishConfigRelease, readReleaseHead, REPUBLISH_AFTER_MS, type PublishDeps } from './publish';
import type { DeclaredAgentRoster } from './session-agent';
import { MemoryConfigArchiveStore, MemoryConfigReleaseLedger } from './__tests__/fakes';

const TIP_A = 'a'.repeat(40);
const TIP_B = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

let accountId: string;
let projectId: string;
let store: MemoryConfigArchiveStore;
let ledger: MemoryConfigReleaseLedger;
let builds: string[];
let scheduled: Array<[string, string, string | null]>;
const schedule = (projectId: string, ref: string, commit: string | null) => void scheduled.push([projectId, ref, commit]);

const release = (commit: string, overrides: Partial<ConfigRelease> = {}): ConfigRelease => ({
  release_id: `${commit.slice(0, 8)}${'0'.repeat(56)}`,
  source_commit: commit,
  config_dir: 'harnesses/opencode',
  config_tree_id: TREE,
  archive: { url: `/v1/projects/${projectId}/config-archives/${TREE}`, bytes: 10 },
  files: [['kortix.yaml', '100644', 'd'.repeat(40)]],
  compiled_governance: '{"default_agent":"build","agent":{"build":{}}}',
  compiled_governance_etag: 'e'.repeat(16),
  reason: null,
  ...overrides,
});

const ROSTER: DeclaredAgentRoster = { enabled: ['build'], defaultAgent: 'build', readable: true, governed: true };

function deps(now: Date, overrides: Partial<ConfigRelease> = {}): PublishDeps {
  return {
    build: async (_project, commit) => {
      builds.push(commit);
      return release(commit, overrides);
    },
    roster: async () => ROSTER,
    resolveTip: async () => TIP_A,
    store: () => store,
    ledger,
    now: () => now,
    schedule,
  };
}

const project = () => ({ projectId, repoUrl: 'https://example.test/r.git', defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: null });

beforeEach(async () => {
  accountId = randomUUID();
  projectId = randomUUID();
  store = new MemoryConfigArchiveStore();
  ledger = new MemoryConfigReleaseLedger();
  builds = [];
  scheduled = [];
  await db.insert(accounts).values({ accountId, name: 'publish test' });
  await db.insert(projects).values({ projectId, accountId, name: 'publish test', repoUrl: 'https://example.test/r.git' });
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('publishConfigRelease', () => {
  test('a tip is built and published once: descriptor in the store, head row, ledger row', async () => {
    const now = new Date();
    expect(await publishConfigRelease(project(), 'main', null, deps(now))).toBe('published');

    const head = await readReleaseHead(projectId, 'main');
    expect(head).toMatchObject({ sourceCommit: TIP_A, configTreeId: TREE, releaseId: release(TIP_A).release_id });
    expect(head!.roster).toEqual({ enabled: ['build'], defaultAgent: 'build', readable: true, governed: true });
    const stored = JSON.parse(store.objects.get(head!.descriptorKey)!.toString());
    expect(stored).toMatchObject({ format: 'config-release-v3', release_id: release(TIP_A).release_id, source_commit: TIP_A, files: release(TIP_A).files });
    expect(ledger.assigned).toEqual([expect.objectContaining({ projectId, releaseId: release(TIP_A).release_id, variant: 'project', sourceCommit: TIP_A })]);

    // The same tip again: nothing is built or written.
    expect(await publishConfigRelease(project(), 'main', TIP_A, deps(new Date(now.getTime() + 1000)))).toBe('current');
    expect(builds).toEqual([TIP_A]);
    expect(store.objects.size).toBe(1);
  });

  test('a publish of an older tip that finishes last never replaces the newer one', async () => {
    const t1 = new Date();
    const t2 = new Date(t1.getTime() + 5_000);
    await publishConfigRelease(project(), 'main', TIP_B, deps(t2));
    expect(await publishConfigRelease(project(), 'main', TIP_A, deps(t1))).toBe('published');
    expect((await readReleaseHead(projectId, 'main'))!.sourceCommit).toBe(TIP_B);
  });

  test('a row older than the republish age is published again under a new key', async () => {
    const old = new Date(Date.now() - REPUBLISH_AFTER_MS - 60_000);
    await publishConfigRelease(project(), 'main', TIP_A, deps(old));
    const first = (await readReleaseHead(projectId, 'main'))!.descriptorKey;
    expect(await publishConfigRelease(project(), 'main', TIP_A, deps(new Date()))).toBe('published');
    expect((await readReleaseHead(projectId, 'main'))!.descriptorKey).not.toBe(first);
  });

  test('a tip with no archive (over the cap) is not published: the box asks the route', async () => {
    expect(await publishConfigRelease(project(), 'main', TIP_A, deps(new Date(), { archive: null }))).toBe('unpublishable');
    expect(await readReleaseHead(projectId, 'main')).toBeNull();
    expect(store.objects.size).toBe(0);
  });
});

describe('configReleaseEnvForSession', () => {
  const read = (value: string | null) => (value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null);

  test('the env names the release and signs its descriptor and archive', async () => {
    const now = new Date();
    await publishConfigRelease(project(), 'main', TIP_A, deps(now));
    const head = (await readReleaseHead(projectId, 'main'))!;

    const env = read(await configReleaseEnvForSession({ projectId, ref: 'main', agentName: 'build', tip: TIP_A }, { store: () => store, ledger, now: () => now, schedule }));

    expect(env).toEqual({
      release_id: head.releaseId,
      source_commit: TIP_A,
      descriptor_url: `https://store.example.com/${head.descriptorKey}?expiresIn=900`,
      archive_url: `https://store.example.com/projects/${projectId}/trees/${TREE}.tar.gz?expiresIn=900`,
      expires_at: new Date(now.getTime() + 900_000).toISOString(),
    });
  });

  test('no env when the row cannot answer as the route would', async () => {
    const now = new Date();
    const env = (agentName: string | null, ref = 'main') =>
      configReleaseEnvForSession({ projectId, ref, agentName, tip: null }, { store: () => store, ledger, now: () => now, schedule });

    // No row yet: a publish starts.
    expect(await env('build')).toBeNull();
    expect(scheduled).toEqual([[projectId, 'main', null]]);
    await publishConfigRelease(project(), 'main', TIP_A, deps(now));
    expect(await env('build')).not.toBeNull();
    // An agent this release does not declare: only the route re-points it.
    expect(await env('reviewer')).toBeNull();
    // A quarantined release.
    const releaseId = (await readReleaseHead(projectId, 'main'))!.releaseId;
    for (const sessionId of ['s1', 's2']) await ledger.recordFailure({ projectId, releaseId, sessionId, reason: 'boom' });
    expect(await env('build')).toBeNull();
  });

  test('a row near the store lifecycle gives no env and starts a republish', async () => {
    await publishConfigRelease(project(), 'main', TIP_A, deps(new Date(Date.now() - REPUBLISH_AFTER_MS - 60_000)));
    expect(await configReleaseEnvForSession({ projectId, ref: 'main', agentName: 'build', tip: null }, { store: () => store, ledger, now: () => new Date(), schedule })).toBeNull();
    expect(scheduled).toEqual([[projectId, 'main', null]]);
  });

  test('one commit behind still serves, and a publish of the tip starts', async () => {
    const now = new Date();
    await publishConfigRelease(project(), 'main', TIP_A, deps(now));
    const env = read(await configReleaseEnvForSession({ projectId, ref: 'main', agentName: 'build', tip: TIP_B }, { store: () => store, ledger, now: () => now, schedule }));
    expect(env.source_commit).toBe(TIP_A);
    expect(scheduled).toEqual([[projectId, 'main', TIP_B]]);
  });

  test('the head row goes with the project', async () => {
    await publishConfigRelease(project(), 'main', TIP_A, deps(new Date()));
    await db.delete(projects).where(eq(projects.projectId, projectId));
    expect(await db.select().from(configReleaseHeads).where(eq(configReleaseHeads.projectId, projectId))).toEqual([]);
  });
});
