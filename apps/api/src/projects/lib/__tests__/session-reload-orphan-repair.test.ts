/**
 * DEF-DEV-1, second half — the husk a swap leaves behind is repaired, not left.
 *
 * A convergence that replaces OpenCode retires the process that was writing a
 * turn. That process emits neither `session.idle` nor `session.error`, so the
 * assistant row it opened stays `completed = null` for ever and the client that
 * sent the prompt gets a bare `HTTP 503`. On dev, R1 kept such a row open with
 * `text ''` and `parts []` for as long as it was observed.
 *
 * Three repair paths existed and none reached it: the runtime-restart recovery
 * is wired to PROVIDER restarts only, the daemon's own finalize asks the NEW
 * process (which never held the husk), and the proxy holds its dedupe claim
 * when the failure is ambiguous, so the prompt cannot simply be re-sent.
 *
 * The daemon now reports the retired process's open assistant message id, and
 * the reload hands it to the SAME repair the provider-restart path uses:
 * settle the open ledger rows `runtime_gone` and requeue the prompt.
 */
import { describe, expect, test } from 'bun:test';
import { reloadSessionConfig, type SessionReloadDeps } from '../session-reload';
import { recoverTurnsAfterRuntimeRestart } from '../../session-lifecycle/runtime-restart-recovery';

const RELEASE_A = 'a'.repeat(64);
const RELEASE_B = 'b'.repeat(64);
const ORPHANED_MESSAGE_ID = 'msg_0123456789abcdef';

const INPUT = {
  projectId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  repoUrl: 'https://git.example/p.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  baseRef: 'main',
};

const healthConfig = (overrides: Record<string, unknown> = {}) => ({
  release_id: RELEASE_A,
  desired_release_id: RELEASE_A,
  source: 'release',
  mode: 'follow-base',
  proven: true,
  fallback_reason: null,
  failed_release_id: null,
  ...overrides,
});

function fakeDaemon(reload: unknown) {
  const repairs: Array<{ sessionId: string; orphanedMessageId: string | null }> = [];
  const deps: SessionReloadDeps = {
    endpoint: async () => ({ baseUrl: 'http://box', headers: {} }),
    fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname === '/kortix/health') {
        return Response.json({
          agent_config_etag: 'eeee',
          commit_sha: 'c'.repeat(40),
          turn_in_flight: false,
          capabilities: ['file.import', 'file.append', 'config.release.v1'],
          config: healthConfig(),
        });
      }
      if (u.pathname === '/kortix/refresh') return Response.json({ repo: { after: { commit: 'd'.repeat(40) } } });
      if (u.pathname === '/kortix/config/converge') {
        return Response.json({
          ok: true,
          outcome: 'applied',
          config: healthConfig({ release_id: RELEASE_B, desired_release_id: RELEASE_B }),
          reload,
          reason: null,
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
    pushGovernance: async () => ({ applied: true, opencodeReload: 'restarted', opencodeTurnEnded: false }) as never,
    latestEtag: async () => 'ffff',
    sleep: async () => {},
    recordReport: async () => {},
    configReleasesEnabled: async () => true,
    repairOrphanedTurn: async (input) => {
      repairs.push(input);
    },
  };
  return { deps, repairs };
}

describe('a convergence that retired a live turn repairs the row it orphaned', () => {
  test('the orphaned message id reaches the repair path', async () => {
    const daemon = fakeDaemon({ how: 'restarted', turn_ended: true, orphaned_message_id: ORPHANED_MESSAGE_ID });

    const result = await reloadSessionConfig(INPUT, daemon.deps);

    expect(result.applied).toBe(true);
    expect(daemon.repairs).toEqual([
      { sessionId: INPUT.sessionId, orphanedMessageId: ORPHANED_MESSAGE_ID },
    ]);
  });

  test('a swap that orphaned nothing repairs nothing', async () => {
    const daemon = fakeDaemon({ how: 'restarted', turn_ended: false, orphaned_message_id: null });
    await reloadSessionConfig(INPUT, daemon.deps);
    expect(daemon.repairs).toEqual([]);
  });

  test('a convergence that replaced nothing repairs nothing', async () => {
    const daemon = fakeDaemon(null);
    await reloadSessionConfig(INPUT, daemon.deps);
    expect(daemon.repairs).toEqual([]);
  });
});

/**
 * The repair itself, at its own seam: every open ledger row is settled
 * `runtime_gone` and every prompt those turns carried is handed to
 * `requeueAbandonedPrompt`. This is the behaviour the reload now reuses
 * instead of writing a second repair path.
 */
describe('the reused repair settles runtime_gone and requeues the prompt', () => {
  test('one open turn settles and redelivers', async () => {
    const requeued: unknown[] = [];
    const result = await recoverTurnsAfterRuntimeRestart(
      { sandboxId: 'sbx-1', sessionId: INPUT.sessionId, hold: false },
      {
        settleLostTurns: async () => [{ token: 'tok-1', messageId: ORPHANED_MESSAGE_ID, state: 'running' }],
        reArmBlockedPrompts: async () => 0,
        kickDrain: () => {},
        requeue: async (input) => {
          requeued.push(input);
          return 'requeued' as never;
        },
      },
    );

    expect(requeued).toEqual([
      {
        sessionId: INPUT.sessionId,
        wireMessageId: ORPHANED_MESSAGE_ID,
        turnToken: 'tok-1',
        endReason: 'runtime_gone',
        hold: false,
      },
    ]);
    expect(result.lost).toHaveLength(1);
  });
});
