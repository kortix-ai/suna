/**
 * INC-2026-09-08-CONNECTOR-GATEWAY: a session token's grant must never be
 * REPLACED by a grant derived from a suspect manifest read. These tests pin
 * the three guards — same-blob drift, stale commit, unreadable manifest — and
 * the one legitimate rewrite (a genuine manifest change).
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import * as realSecretGrant from './secret-grant';

const COMMIT_OLD = 'a'.repeat(40);
const COMMIT_NEW = 'b'.repeat(40);
const BLOB_OLD = 'c'.repeat(40);
const BLOB_NEW = 'd'.repeat(40);

const storedGrant: AgentGrant = {
  agent: 'kortix',
  connectors: 'all',
  kortixCli: 'all',
  env: 'all',
  manifestRevision: BLOB_NEW,
  manifestCommit: COMMIT_NEW,
};

let resolvedGrant: AgentGrant | null = null;
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

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionAgentGrant: async () => {
    if (resolveError) throw resolveError;
    resolveCalls += 1;
    if (resolveCalls >= 2) return secondResolvedGrant === 'stored' ? storedForTest : secondResolvedGrant;
    return resolvedGrant;
  },
}));

mock.module('../git/mirror', () => ({
  existingProjectMirrorPath: () => '/tmp/mirror.git',
  runGitCapture: async (args: string[]) => {
    ancestorCalls.push(args);
    return { stdout: '', stderr: '', exitCode: ancestorAnswer ? 0 : 1 };
  },
}));

const { reconcileStoredSessionAgentGrant, remintDecisionFor, resetGrantRefreshCooldownForTest } =
  await import('./session-token-grant');

const denyAll = (overrides: Partial<AgentGrant>): AgentGrant => ({
  agent: 'kortix',
  connectors: [],
  kortixCli: [],
  env: [],
  ...overrides,
});

beforeEach(() => {
  resolvedGrant = null;
  secondResolvedGrant = 'stored';
  resolveCalls = 0;
  resolveError = null;
  writtenGrant = undefined;
  ancestorAnswer = false;
  ancestorCalls = [];
  selectCount = 0;
  storedForTest = storedGrant;
  resetGrantRefreshCooldownForTest();
});

test('same manifest blob, different grant, second read agrees with STORED → the glitched read is dropped', async () => {
  resolvedGrant = denyAll({ manifestRevision: BLOB_NEW, manifestCommit: COMMIT_NEW });
  secondResolvedGrant = 'stored';
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(storedGrant);
  expect(writtenGrant).toBeUndefined();
  expect(ancestorCalls).toEqual([]);
  expect(resolveCalls).toBe(2);
});

test('same manifest blob, different grant, second read agrees with the FRESH read → the stored glitch is replaced', async () => {
  // The boot-time mint has no provenance policy; if THAT read glitched, the
  // stored grant is the odd one out and two consistent reads must win.
  const fresh = denyAll({ manifestRevision: BLOB_NEW, manifestCommit: COMMIT_NEW });
  resolvedGrant = fresh;
  secondResolvedGrant = { ...fresh };
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(fresh);
  expect(writtenGrant).toEqual(fresh);
  expect(resolveCalls).toBe(2);
});

test('manifest read at an ANCESTOR commit → stale read, the stored grant is kept', async () => {
  resolvedGrant = denyAll({ manifestRevision: BLOB_OLD, manifestCommit: COMMIT_OLD });
  ancestorAnswer = true;
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(storedGrant);
  expect(writtenGrant).toBeUndefined();
  expect(ancestorCalls).toEqual([['merge-base', '--is-ancestor', COMMIT_OLD, COMMIT_NEW]]);
});

test('manifest read at a NEW commit that narrows the agent → applied and written', async () => {
  const narrowed = { ...denyAll({}), connectors: ['kortix_slack'], manifestRevision: 'e'.repeat(40), manifestCommit: 'f'.repeat(40) };
  resolvedGrant = narrowed;
  ancestorAnswer = false;
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(narrowed);
  expect(writtenGrant).toEqual(narrowed);
});

test('manifest unreadable on the gateway path → last-known-good stored grant, no write', async () => {
  resolveError = new Error('git fetch timed out');
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(storedGrant);
  expect(writtenGrant).toBeUndefined();
});

test('manifest unreadable with NOTHING stored still fails closed', async () => {
  storedForTest = null;
  resolveError = new Error('git fetch timed out');
  await expect(
    reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' }),
  ).rejects.toThrow('git fetch timed out');
});

test('an unrestricted resolution over a narrower stored grant answers with the stored grant instead of 500', async () => {
  const narrow = { ...storedGrant, connectors: ['kortix_slack'] };
  storedForTest = narrow;
  resolvedGrant = null;
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(narrow);
  expect(writtenGrant).toBeUndefined();
});

test('equal grants with new provenance are written once so the next comparison has a blob to reason with', async () => {
  storedForTest = { agent: 'kortix', connectors: 'all', kortixCli: 'all', env: 'all' };
  resolvedGrant = { ...storedForTest, manifestRevision: BLOB_NEW, manifestCommit: COMMIT_NEW };
  const grant = await reconcileStoredSessionAgentGrant({ projectId: 'p1', sessionId: 's1' });
  expect(grant).toEqual(resolvedGrant);
  expect(writtenGrant).toEqual(resolvedGrant);
});

test('forced mirror refresh is bounded by the cooldown on the gateway path', async () => {
  const seen: boolean[] = [];
  mock.module('./secret-grant', () => ({
    ...realSecretGrant,
    resolveSessionAgentGrant: async (input: { forceRefresh?: boolean }) => {
      seen.push(input.forceRefresh === true);
      return storedGrant;
    },
  }));
  const fresh = await import('./session-token-grant');
  fresh.resetGrantRefreshCooldownForTest();
  await fresh.reconcileStoredSessionAgentGrant({ projectId: 'p-cool', sessionId: 's1' });
  selectCount = 0;
  await fresh.reconcileStoredSessionAgentGrant({ projectId: 'p-cool', sessionId: 's1' });
  expect(seen).toEqual([true, false]);
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
