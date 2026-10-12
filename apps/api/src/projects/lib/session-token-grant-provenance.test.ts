/**
 * INC-2026-09-08-CONNECTOR-GATEWAY: a session token's grant must never be
 * REPLACED by a grant derived from a suspect manifest read. These tests pin
 * the three guards — same-blob drift, stale commit, unreadable manifest — and
 * the one legitimate rewrite (a genuine manifest change).
 *
 * The gateway reconcile reads the manifest ONCE (`loadProjectAgents`, tip
 * proof) and derives the grant purely from what it loaded; the STRICT
 * tie-break read still goes through `resolveSessionAgentGrant`
 * (`resolveCurrentGrant`). The mocks follow that split: the fresh read is
 * simulated by the `loadProjectAgents` mock, the tie-break by the
 * `resolveSessionAgentGrant` mock.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import * as realSecretGrant from './secret-grant';
import * as realAgents from '../agents';
import type { LoadedAgents } from '../agents';

const COMMIT_OLD = 'a'.repeat(40);
const COMMIT_NEW = 'b'.repeat(40);
const BLOB_OLD = 'c'.repeat(40);
const BLOB_NEW = 'd'.repeat(40);

const storedGrant: AgentGrant = {
  agent: 'kortix',
  connectors: 'all',
  permissions: 'all',
  env: 'all',
  manifestRevision: BLOB_NEW,
  manifestCommit: COMMIT_NEW,
};

/** What the FIRST (tip-proof) read loads; `null` = the manifest read failed. */
let loadedAgents: LoadedAgents | null = null;
let loadOpts: unknown[] = [];
/** What the SECOND (confirming) read answers; defaults to the stored grant. */
let secondResolvedGrant: AgentGrant | null | 'stored' = 'stored';
let resolveCalls = 0;
let resolveError: Error | null = null;
let writtenGrant: AgentGrant | null | undefined;
let ancestorAnswer = false;
let ancestorCalls: string[][] = [];
let selectCount = 0;
let storedForTest: AgentGrant | null = storedGrant;

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCount += 1;
            if (selectCount === 1) return [{ agentGrant: storedForTest }];
            return [
              {
                repoUrl: 'https://example.test/acme/repo.git',
                defaultBranch: 'main',
                manifestPath: 'kortix.yaml',
              },
            ];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: { agentGrant: AgentGrant | null }) => {
        writtenGrant = values.agentGrant;
        return { where: () => ({ returning: async () => [{ tokenId: 'token-1' }] }) };
      },
    }),
  },
}));

mock.module('../agents', () => ({
  ...realAgents,
  loadProjectAgents: async (_input: unknown, opts: { forceRefresh?: unknown }) => {
    loadOpts.push(opts?.forceRefresh);
    if (resolveError) throw resolveError;
    if (!loadedAgents) throw new Error('no manifest loaded for this scenario');
    return loadedAgents;
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  // The tie-break read: in the reconcile this is the SECOND manifest read and
  // the FIRST call this mock sees (the fresh read runs through
  // `loadProjectAgents` above).
  resolveSessionAgentGrant: async () => {
    if (resolveError) throw resolveError;
    resolveCalls += 1;
    return secondResolvedGrant === 'stored' ? storedForTest : secondResolvedGrant;
  },
}));

mock.module('../git/mirror', () => ({
  existingProjectMirrorPath: () => '/tmp/mirror.git',
  runGitCapture: async (args: string[]) => {
    ancestorCalls.push(args);
    return { stdout: '', stderr: '', exitCode: ancestorAnswer ? 0 : 1 };
  },
}));

const { reconcileStoredSessionAgentGrant, remintDecisionFor } = await import('./session-token-grant');

const denyAll = (overrides: Partial<AgentGrant>): AgentGrant => ({
  agent: 'kortix',
  connectors: [],
  permissions: [],
  env: [],
  ...overrides,
});

/** The LoadedAgents a tip-proof read would have loaded for `grant` at `commit`. */
const loadedOf = (grant: Pick<AgentGrant, 'connectors' | 'permissions' | 'env'> | null, revision: string, commit: string): LoadedAgents => ({
  specs: grant
    ? [
        {
          name: 'kortix',
          path: 'kortix.yaml',
          file: null,
          model: null,
          enabled: true,
          connectors: grant.connectors,
          permissions: grant.permissions,
          env: grant.env ?? [],
        },
      ]
    : [],
  errors: [],
  manifest: { revision, commit },
});

/**
 * What the reconcile derives from a loaded manifest: the pure derivation the
 * module itself performs (`withGrantProvenance(grantFromLoadedAgents(...))`),
 * with the timestamp normalized — `resolvedAt` is `now()` at derive time.
 */
const derivedRunning = (agentName: string, loaded: LoadedAgents): AgentGrant | null => {
  const grant = realSecretGrant.withGrantProvenance(
    realAgents.grantFromLoadedAgents(agentName, loaded),
    loaded,
  );
  if (!grant) return null;
  return { ...grant, resolvedAt: expect.any(String) as unknown as string };
};

beforeEach(() => {
  loadedAgents = null;
  loadOpts = [];
  secondResolvedGrant = 'stored';
  resolveCalls = 0;
  resolveError = null;
  writtenGrant = undefined;
  ancestorAnswer = false;
  ancestorCalls = [];
  selectCount = 0;
  storedForTest = storedGrant;
});

test('same manifest blob, different grant, second read agrees with STORED → the glitched read is dropped', async () => {
  loadedAgents = loadedOf(denyAll({}), BLOB_NEW, COMMIT_NEW);
  secondResolvedGrant = 'stored';
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(storedGrant);
  expect(writtenGrant).toBeUndefined();
  expect(ancestorCalls).toEqual([]);
  expect(loadOpts).toEqual(['tip-proof']);
  expect(resolveCalls).toBe(1);
});

test('same manifest blob, different grant, second read agrees with the FRESH read → the stored glitch is replaced', async () => {
  // The boot-time mint has no provenance policy; if THAT read glitched, the
  // stored grant is the odd one out and two consistent reads must win.
  loadedAgents = loadedOf(denyAll({}), BLOB_NEW, COMMIT_NEW);
  secondResolvedGrant = { ...denyAll({ manifestRevision: BLOB_NEW, manifestCommit: COMMIT_NEW }) };
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(derivedRunning('kortix', loadedAgents));
  expect(writtenGrant).toEqual(derivedRunning('kortix', loadedAgents));
  expect(resolveCalls).toBe(1);
});

test('manifest read at an ANCESTOR commit → stale read, the stored grant is kept', async () => {
  loadedAgents = loadedOf(denyAll({}), BLOB_OLD, COMMIT_OLD);
  ancestorAnswer = true;
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(storedGrant);
  expect(writtenGrant).toBeUndefined();
  expect(ancestorCalls).toEqual([['merge-base', '--is-ancestor', COMMIT_OLD, COMMIT_NEW]]);
});

test('manifest read at a NEW commit that narrows the agent → applied and written', async () => {
  const narrowedSource = { connectors: ['kortix_slack'] as string[] | 'all', permissions: [] as string[] | 'all', env: [] as string[] | 'all' };
  loadedAgents = loadedOf(narrowedSource, 'e'.repeat(40), 'f'.repeat(40));
  ancestorAnswer = false;
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(derivedRunning('kortix', loadedAgents));
  expect(grant && 'connectors' in grant ? grant.connectors : null).toEqual(['kortix_slack']);
  expect(writtenGrant).toEqual(derivedRunning('kortix', loadedAgents));
});

test('manifest unreadable on the gateway path → last-known-good stored grant, no write', async () => {
  loadedAgents = null;
  resolveError = new Error('git fetch timed out');
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(storedGrant);
  expect(writtenGrant).toBeUndefined();
});

test('manifest unreadable with NOTHING stored still fails closed', async () => {
  storedForTest = null;
  loadedAgents = null;
  resolveError = new Error('git fetch timed out');
  await expect(
    reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' }),
  ).rejects.toThrow('git fetch timed out');
});

test('an unrestricted resolution over a narrower stored grant answers with the stored grant instead of 500', async () => {
  const narrow = { ...storedGrant, connectors: ['kortix_slack'] };
  storedForTest = narrow;
  // No specs and no errors: the project has no per-agent governance — the
  // fresh resolution is the unrestricted `null`.
  loadedAgents = { specs: [], errors: [], manifest: { revision: BLOB_NEW, commit: COMMIT_NEW } };
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(narrow);
  expect(writtenGrant).toBeUndefined();
});

test('equal grants with new provenance are written once so the next comparison has a blob to reason with', async () => {
  storedForTest = { agent: 'kortix', connectors: 'all', permissions: 'all', env: 'all' };
  loadedAgents = loadedOf({ connectors: 'all', permissions: 'all', env: 'all' }, BLOB_NEW, COMMIT_NEW);
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(derivedRunning('kortix', loadedAgents));
  expect(grant?.manifestRevision).toBe(BLOB_NEW);
  expect(writtenGrant).toEqual(derivedRunning('kortix', loadedAgents));
});

test('the gateway path reads with the tip proof and breaks a same-blob tie with a strict read', async () => {
  loadedAgents = loadedOf(denyAll({}), BLOB_NEW, COMMIT_NEW);
  secondResolvedGrant = 'stored';
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p-proof', sessionId: 's1' });
  // The fresh read ran tip-proof; the tie-break read went out strict.
  expect(loadOpts).toEqual(['tip-proof']);
  expect(resolveCalls).toBe(1);
  expect(secondResolvedGrant).toBe('stored');
  // The tie-break contradicted the fresh read → the stored grant stays.
  expect(grant).toEqual(storedGrant);
});

test('pure policy: same blob → keep; stale read → keep; new commit → write; equal → skip', () => {
  const stored = storedGrant;
  expect(remintDecisionFor(stored, denyAll({ manifestRevision: BLOB_NEW, manifestCommit: COMMIT_NEW }))).toEqual({
    action: 'keep',
    reason: 'same_manifest_drift',
    grant: stored,
  });
  expect(
    remintDecisionFor(stored, denyAll({ manifestRevision: BLOB_OLD, manifestCommit: COMMIT_OLD }), { staleRead: true }),
  ).toEqual({ action: 'keep', reason: 'stale_manifest_read', grant: stored });
  const next = denyAll({ manifestRevision: BLOB_OLD, manifestCommit: COMMIT_OLD });
  expect(remintDecisionFor(stored, next)).toEqual({ action: 'write', grant: next });
  expect(remintDecisionFor(stored, { ...stored })).toEqual({ action: 'skip' });
  // A different AGENT on the same blob is a real switch, not drift.
  const other = denyAll({ agent: 'release-bot', manifestRevision: BLOB_NEW, manifestCommit: COMMIT_NEW });
  expect(remintDecisionFor(stored, other)).toEqual({ action: 'write', grant: other });
});
