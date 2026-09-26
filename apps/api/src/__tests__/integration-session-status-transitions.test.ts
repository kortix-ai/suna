/**
 * Integration test (real local PostgreSQL): the session and sandbox status
 * writers of the session lifecycle.
 *
 * Every case drives a SHIPPED writer against real rows and reads the rows
 * back. The cases pin three things:
 *   - the transitions a live session makes (stop, park, lose, recover,
 *     restart claim) and the metadata each one leaves behind;
 *   - the guards each write holds: a deleted session is not revived, an
 *     archived row stays archived, a `failed` park survives a later stop, and a
 *     metadata key a concurrent writer added is never reverted;
 *   - the park holds no transaction and no row lock across `provider.stop()`.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import * as realComputeMetering from '../billing/services/compute-metering';
import * as realProviders from '../platform/providers';
import * as realSandboxRuntimeRefresh from '../projects/lib/sandbox-runtime-refresh';
import * as realSessionAttachments from '../projects/lib/session-attachments';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

let providerStops = 0;
/** What the provider stop does besides counting. Reset after each park case. */
let onProviderStop: () => Promise<void> = async () => {};
/** What the provider remove does. Reset after each delete case. */
let onProviderRemove: () => Promise<void> = async () => {};
let providerStatus = 'stopped';
let providerStarts = 0;
/** What the provider start waits on. A resume case gates it to race a writer. */
let onProviderStart: () => Promise<void> = async () => {};
/** Compute meters (re)opened: one per runtime that became active. */
let computeReopens = 0;
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    start: async () => {
      providerStarts += 1;
      await onProviderStart();
    },
    stop: async () => {
      providerStops += 1;
      await onProviderStop();
    },
    remove: async () => onProviderRemove(),
    getStatus: async () => providerStatus,
  }),
}));
// The delete clears the session's stored attachments in object storage, which
// this lane does not run. The database half of the delete is the subject.
mock.module('../projects/lib/session-attachments', () => ({
  ...realSessionAttachments,
  sessionAttachmentStore: () => ({ removeSession: async () => undefined }),
}));

// Billing and the post-wake daemon refresh are other lanes. The count of
// meter reopens is the billing half of the resume contract.
mock.module('../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  reopenComputeForSandbox: async () => {
    computeReopens += 1;
  },
  markComputeSessionAlive: async () => undefined,
}));
mock.module('../projects/lib/sandbox-runtime-refresh', () => ({
  ...realSandboxRuntimeRefresh,
  scheduleSandboxRuntimeRefresh: () => undefined,
}));

const { applyStoppedState } = await import('../projects/reaping/sandbox-state-sync');
const { resumeStoppedSandbox } = await import('../projects/routes/shared');
const {
  claimInPlaceRuntimeRecovery,
  markInPlaceRuntimeRecoveryAccepted,
  parkEstablishedRuntime,
  preserveEstablishedRuntime,
} = await import('../projects/runtime-identity');
const { claimInPlaceRestart } = await import('../projects/session-lifecycle/runtime-restart-claim');
const { deleteSession } = await import('../projects/session-lifecycle/actions');
const { stopSession } = await import('../projects/session-lifecycle/stop');
const { beginSandboxTurn } = await import('../projects/sandbox-turn-lifecycle');
const { transitionRuntime, transitionSandbox, transitionSession } = await import(
  '../projects/session-lifecycle/status-transitions'
);
const { RUNTIME_WAKE_LATE_START_GUARD_MS } = await import(
  '../projects/session-lifecycle/runtime-wake-fence'
);

type Row = Record<string, unknown>;
const rows = (result: unknown) => ((result as { rows?: Row[] }).rows ?? result) as Row[];

let project: SeededProject;
const created: string[] = [];

interface Fixture {
  sessionId: string;
  sandboxId: string;
  externalId: string;
}

async function fixture(input: {
  sessionStatus: string;
  sessionError?: string;
  sessionSandboxUrl?: string;
  sandboxStatus: string;
  sessionMetadata?: Row;
  sandboxMetadata?: Row;
  /** A first provisioning has no provider box yet. */
  withoutExternalId?: true;
}): Promise<Fixture> {
  const sessionId = crypto.randomUUID();
  const externalId = `sbx_transition_${sessionId.slice(0, 8)}`;
  await db.execute(sql`
    insert into kortix.project_sessions
      (session_id, account_id, project_id, branch_name, agent_name, status, error, sandbox_url,
       metadata)
    values
      (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, ${sessionId},
       'default', ${input.sessionStatus}::kortix.project_session_status,
       ${input.sessionError ?? null}, ${input.sessionSandboxUrl ?? null},
       ${JSON.stringify(input.sessionMetadata ?? {})}::jsonb)`);
  await db.execute(sql`
    insert into kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, provider, status, metadata,
       updated_at)
    values
      (${sessionId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
       ${input.withoutExternalId ? null : externalId}, 'daytona',
       ${input.sandboxStatus}::kortix.session_sandbox_status,
       ${JSON.stringify(input.sandboxMetadata ?? {})}::jsonb,
       -- The API writes updated_at from a JS Date (millisecond precision), and
       -- the park CAS compares it to one.
       date_trunc('milliseconds', now()))`);
  created.push(sessionId);
  return { sessionId, sandboxId: sessionId, externalId };
}

async function read(f: Fixture): Promise<{
  session: { status: string; error: string | null; sandbox_url: string | null; metadata: Row };
  sandbox: { status: string; metadata: Row; updated_at: Date } & Row;
}> {
  const [session] = rows(
    await db.execute(sql`
      select status, error, sandbox_url, metadata from kortix.project_sessions
       where session_id = ${f.sessionId}`),
  );
  const [sandbox] = rows(
    await db.execute(sql`
      select * from kortix.session_sandboxes where sandbox_id = ${f.sandboxId}::uuid`),
  );
  return { session: session as never, sandbox: sandbox as never };
}

/** A write by some OTHER lifecycle writer, landing after a caller read the row. */
async function concurrentMetadataWrite(f: Fixture, patch: Row): Promise<void> {
  await db.execute(sql`
    update kortix.session_sandboxes
       set metadata = coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
     where sandbox_id = ${f.sandboxId}::uuid`);
}

async function sandboxRow(f: Fixture) {
  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, f.sandboxId))
    .limit(1);
  return { ...row!, externalId: row!.externalId! };
}

beforeAll(async () => {
  project = await seedProject('status-transitions-test');
});

afterAll(async () => {
  for (const sessionId of created) {
    // `guard_session_sandbox_identity` refuses to delete the sandbox row of a
    // session that is not tombstoned.
    await db.execute(sql`
      update kortix.project_sessions
         set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb
       where session_id = ${sessionId}`);
    await db.execute(sql`delete from kortix.session_turns where session_id = ${sessionId}`);
    await db.execute(
      sql`delete from kortix.session_sandboxes where sandbox_id = ${sessionId}::uuid`,
    );
    await db.execute(sql`delete from kortix.project_sessions where session_id = ${sessionId}`);
  }
  await removeSeeded([project]);
});

describe('stop (applyStoppedState)', () => {
  test('parks an active box and its running session, merging the patch', async () => {
    const f = await fixture({
      sessionStatus: 'running',
      // The stop names neither, so it keeps both.
      sessionError: 'an earlier turn failed',
      sessionSandboxUrl: 'https://box.test/p/sbx/8000',
      sandboxStatus: 'active',
      sandboxMetadata: {
        lastAliveAt: '2026-09-25T10:00:00.000Z',
        runtimeWakeId: 'wake-1',
        runtimeWakeStartedAt: '2026-09-25T10:00:00.000Z',
        activeTurn: { token: 'legacy-turn' },
        activeTurns: {},
        lifecycleStopClaim: { token: 'claim-1' },
        pendingStopObservedAtMs: 1,
      },
    });
    await applyStoppedState({
      sandboxId: f.sandboxId,
      sessionId: f.sessionId,
      externalId: f.externalId,
      stopReason: 'manual',
      // A nested stopReason never lands: the required top-level one is the
      // single source of truth for why a box parked.
      metadata: { stoppedBy: 'user-1', stopReason: 'run_cap' },
    });
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('stopped');
    expect(session.error).toBe('an earlier turn failed');
    expect(session.sandbox_url).toBe('https://box.test/p/sbx/8000');
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.metadata.stopReason).toBe('manual');
    expect(sandbox.metadata.stoppedAt).toEqual(expect.any(String));
    expect(sandbox.metadata.stoppedBy).toBe('user-1');
    expect(sandbox.metadata.lastAliveAt).toBe('2026-09-25T10:00:00.000Z');
    // The stop removes every in-flight wake key and all turn authority in the
    // same statement, so a committed stop wins the start/stop race.
    for (const key of [
      'runtimeWakeId',
      'runtimeWakeStartedAt',
      'activeTurn',
      'activeTurns',
      'lifecycleStopClaim',
      'pendingStopObservedAtMs',
    ]) {
      expect(sandbox.metadata).not.toHaveProperty(key);
    }
  });

  test('keeps a dead-lettered `failed` session failed, with its error', async () => {
    const f = await fixture({
      sessionStatus: 'failed',
      sessionError: 'prompt delivery dead-lettered: out of retries',
      sandboxStatus: 'active',
    });
    await applyStoppedState({
      sandboxId: f.sandboxId,
      sessionId: f.sessionId,
      externalId: f.externalId,
      stopReason: 'deadline_expired',
    });
    const { session, sandbox } = await read(f);
    expect(sandbox.status).toBe('stopped');
    expect(session.status).toBe('failed');
    expect(session.error).toBe('prompt delivery dead-lettered: out of retries');
  });

  test('leaves the archived row of a deleted session archived', async () => {
    const f = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'archived',
      sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
      sandboxMetadata: { providerRemovalPendingAt: '2026-09-25T10:00:00.000Z' },
    });
    await applyStoppedState({
      sandboxId: f.sandboxId,
      sessionId: f.sessionId,
      externalId: f.externalId,
      stopReason: 'provider_reconcile',
    });
    const { sandbox } = await read(f);
    expect(sandbox.status).toBe('archived');
    expect(sandbox.metadata.providerRemovalPendingAt).toBe('2026-09-25T10:00:00.000Z');
  });
});

describe('runtime lost (preserveEstablishedRuntime)', () => {
  test('stops both rows and records the loss', async () => {
    const f = await fixture({
      sessionStatus: 'running',
      sandboxStatus: 'active',
      sandboxMetadata: { needsReprovision: true, runtimeRecoveryLeaseId: 'lease-old' },
    });
    const preserved = await preserveEstablishedRuntime(
      await sandboxRow(f),
      'integration_test',
      'provider_removed',
    );
    expect(preserved?.status).toBe('stopped');
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('stopped');
    expect(session.error).toContain('original sandbox is unavailable');
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.metadata.runtimeIdentityState).toBe('unavailable');
    expect(sandbox.metadata.stopReason).toBe('provider_removed');
    expect(sandbox.metadata.preservedExternalId).toBe(f.externalId);
    expect(sandbox.metadata).not.toHaveProperty('needsReprovision');
    expect(sandbox.metadata).not.toHaveProperty('runtimeRecoveryLeaseId');
  });

  test('keeps a metadata key written after the caller read the row', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    const snapshot = await sandboxRow(f);
    await concurrentMetadataWrite(f, { lastAliveAt: '2026-09-25T11:00:00.000Z' });
    await preserveEstablishedRuntime(snapshot, 'integration_test', 'provider_removed');
    const { sandbox } = await read(f);
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.metadata.lastAliveAt).toBe('2026-09-25T11:00:00.000Z');
  });

  test('writes nothing for a deleted session', async () => {
    const f = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'stopped',
      sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
    });
    const before = await read(f);
    expect(
      await preserveEstablishedRuntime(await sandboxRow(f), 'integration_test', 'provider_removed'),
    ).toBeNull();
    const after = await read(f);
    expect(after.sandbox.metadata).toEqual(before.sandbox.metadata);
    expect(after.session.error).toBeNull();
  });
});

describe('park (parkEstablishedRuntime)', () => {
  test('parks an active runtime and stops its box', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    const stopsBefore = providerStops;
    const parked = await parkEstablishedRuntime(
      await sandboxRow(f),
      'integration_test',
      'runtime_boot_failed',
    );
    expect(parked?.status).toBe('stopped');
    expect(providerStops).toBe(stopsBefore + 1);
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('stopped');
    expect(sandbox.metadata.stopReason).toBe('runtime_boot_failed');
    expect(sandbox.metadata).not.toHaveProperty('runtimeIdentityState');
  });

  test('refuses a row that changed since the caller read it', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    const snapshot = await sandboxRow(f);
    await db.execute(sql`
      update kortix.session_sandboxes set updated_at = now() + interval '1 second'
       where sandbox_id = ${f.sandboxId}::uuid`);
    const stopsBefore = providerStops;
    expect(
      await parkEstablishedRuntime(snapshot, 'integration_test', 'runtime_boot_failed'),
    ).toBeNull();
    expect(providerStops).toBe(stopsBefore);
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('running');
    expect(sandbox.status).toBe('active');
  });

  test('holds no row lock while the provider stops the box', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    let concurrentWrite = 'not attempted' as string;
    onProviderStop = async () => {
      // Another writer of this row, bounded by a lock timeout: it lands only
      // when no open transaction holds the row.
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '1s'`);
          await tx.execute(sql`
            update kortix.session_sandboxes
               set metadata = coalesce(metadata, '{}'::jsonb) || '{"lastAliveAt":"during-stop"}'::jsonb
             where sandbox_id = ${f.sandboxId}::uuid`);
        });
        concurrentWrite = 'landed';
      } catch (err) {
        concurrentWrite = err instanceof Error ? err.message : String(err);
      }
    };
    try {
      const parked = await parkEstablishedRuntime(
        await sandboxRow(f),
        'integration_test',
        'runtime_boot_failed',
      );
      expect(parked?.status).toBe('stopped');
    } finally {
      onProviderStop = async () => {};
    }
    expect(concurrentWrite).toBe('landed');
    const { sandbox } = await read(f);
    expect(sandbox.metadata.lastAliveAt).toBe('during-stop');
    expect(sandbox.metadata).not.toHaveProperty('lifecycleStopClaim');
  });

  test('a failed provider stop leaves the runtime active and releases the claim', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    onProviderStop = async () => {
      throw new Error('provider unavailable');
    };
    try {
      expect(
        await parkEstablishedRuntime(await sandboxRow(f), 'integration_test', 'runtime_boot_failed'),
      ).toBeNull();
    } finally {
      onProviderStop = async () => {};
    }
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('running');
    expect(sandbox.status).toBe('active');
    expect(sandbox.metadata).not.toHaveProperty('lifecycleStopClaim');
    expect(sandbox.metadata).not.toHaveProperty('stopReason');
  });

  test('a new prompt and a restart refuse the row while the stop is in flight', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    let restartClaimed = null as boolean | null;
    let promptDuringStop = null as string | null;
    let claimDuringStop = undefined as Record<string, unknown> | undefined;
    onProviderStop = async () => {
      claimDuringStop = (await read(f)).sandbox.metadata.lifecycleStopClaim as
        | Record<string, unknown>
        | undefined;
      promptDuringStop = await beginSandboxTurn(
        { sandboxId: f.sandboxId },
        { token: crypto.randomUUID(), opencodeSessionId: 'ses_root', messageId: 'msg_during_stop' },
        60_000,
      );
      const startedAt = new Date();
      restartClaimed = await claimInPlaceRestart({
        sandboxId: f.sandboxId,
        externalId: f.externalId,
        claim: {
          id: crypto.randomUUID(),
          startedAt,
          leaseExpiresAt: new Date(startedAt.getTime() + 240_000),
        },
      });
    };
    try {
      await parkEstablishedRuntime(await sandboxRow(f), 'integration_test', 'runtime_boot_failed');
    } finally {
      onProviderStop = async () => {};
    }
    expect(claimDuringStop).toMatchObject({ token: expect.any(String) });
    expect(promptDuringStop).toBe('no_box');
    expect(restartClaimed).toBe(false);
    expect((await read(f)).sandbox.status).toBe('stopped');
  });

  test('drops turn authority and wake fences with the runtime', async () => {
    const f = await fixture({
      sessionStatus: 'running',
      sandboxStatus: 'active',
      sandboxMetadata: {
        activeTurns: { t1: { token: 't1', state: 'active' } },
        runtimeWakeId: 'wake-old',
        lastAliveAt: '2026-09-25T10:00:00.000Z',
      },
    });
    await parkEstablishedRuntime(await sandboxRow(f), 'integration_test', 'runtime_boot_failed');
    const { sandbox } = await read(f);
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.metadata).not.toHaveProperty('activeTurns');
    expect(sandbox.metadata).not.toHaveProperty('runtimeWakeId');
    expect(sandbox.metadata.lastAliveAt).toBe('2026-09-25T10:00:00.000Z');
  });
});

describe('in-place recovery (claim, then accept)', () => {
  test('claims the row, then activates it and drops the lease', async () => {
    const f = await fixture({ sessionStatus: 'stopped', sandboxStatus: 'stopped' });
    const claim = await claimInPlaceRuntimeRecovery((await sandboxRow(f)) as never);
    expect(claim).not.toBeNull();
    let state = await read(f);
    expect(state.session.status).toBe('provisioning');
    expect(state.sandbox.status).toBe('provisioning');
    expect(state.sandbox.metadata.runtimeIdentityState).toBe('recovery_claimed');

    await concurrentMetadataWrite(f, { egressPin: 'pin-1' });
    const accepted = await markInPlaceRuntimeRecoveryAccepted(claim!, 'running');
    expect(accepted?.status).toBe('active');
    state = await read(f);
    expect(state.session.status).toBe('running');
    expect(state.sandbox.status).toBe('active');
    expect(state.sandbox.metadata.runtimeIdentityState).toBe('recovered');
    expect(state.sandbox.metadata).not.toHaveProperty('runtimeRecoveryLeaseId');
    expect(state.sandbox.metadata.egressPin).toBe('pin-1');
  });

  test('a second claim inside the lease is refused', async () => {
    const f = await fixture({ sessionStatus: 'stopped', sandboxStatus: 'stopped' });
    expect(await claimInPlaceRuntimeRecovery((await sandboxRow(f)) as never)).not.toBeNull();
    // A caller holding a snapshot from before the first claim.
    const stale = { ...(await sandboxRow(f)), metadata: {} };
    expect(await claimInPlaceRuntimeRecovery(stale as never)).toBeNull();
  });

  test('a deleted session is never claimed', async () => {
    const f = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'stopped',
      sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
    });
    expect(await claimInPlaceRuntimeRecovery((await sandboxRow(f)) as never)).toBeNull();
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('stopped');
    expect(sandbox.status).toBe('stopped');
  });

  // The delete lands between the claim and the provider's answer. The accept
  // must not bring the session back to `running` or open a meter.
  test('a delete that lands during recovery wins over the accept', async () => {
    const f = await fixture({ sessionStatus: 'stopped', sandboxStatus: 'stopped' });
    const claim = await claimInPlaceRuntimeRecovery((await sandboxRow(f)) as never);
    expect(claim).not.toBeNull();
    onProviderRemove = async () => {};
    computeReopens = 0;
    expect(
      await deleteSession({
        projectId: project.project_id,
        sessionId: f.sessionId,
        accountId: project.account_id,
        userId: 'user-1',
      }),
    ).toEqual({ ok: true });

    expect(await markInPlaceRuntimeRecoveryAccepted(claim!, 'running')).toBeNull();
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('stopped');
    expect(session.metadata).toMatchObject({ deletedBy: 'user-1' });
    expect(sandbox.status).toBe('archived');
    expect(computeReopens).toBe(0);
  });
});

describe('resume (resumeStoppedSandbox)', () => {
  /** A stopped session whose provider box is stopped, and a gate on its start. */
  async function stoppedFixture() {
    const f = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'stopped',
      sandboxMetadata: { initStatus: 'ready' },
    });
    let releaseStart = () => {};
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    onProviderStart = () => started;
    providerStatus = 'stopped';
    providerStarts = 0;
    providerStops = 0;
    computeReopens = 0;
    const row = {
      sandboxId: f.sandboxId,
      sessionId: f.sessionId,
      accountId: project.account_id,
      provider: 'daytona',
      externalId: f.externalId,
      metadata: { initStatus: 'ready' },
    };
    return { f, row, releaseStart };
  }

  async function until(condition: () => Promise<boolean> | boolean): Promise<void> {
    for (let i = 0; i < 150; i += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the resume never reached the expected state');
  }

  // The wake claim is a compare-and-set on the sandbox metadata. Two callers
  // that read the same stopped row race it; one wins.
  test('concurrent resumes issue one provider start, and one meter opens once the box runs', async () => {
    const { f, row, releaseStart } = await stoppedFixture();
    try {
      const results = await Promise.all([resumeStoppedSandbox(row), resumeStoppedSandbox(row)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await until(() => providerStarts > 0);
      expect(providerStarts).toBe(1);
      // Both rows stay stopped, and billing stays closed, until the provider
      // reports the box running.
      let state = await read(f);
      expect(state.session.status).toBe('stopped');
      expect(state.sandbox.status).toBe('stopped');
      expect(typeof state.sandbox.metadata.runtimeWakeId).toBe('string');
      expect(computeReopens).toBe(0);

      providerStatus = 'running';
      releaseStart();
      await until(async () => (await read(f)).sandbox.status === 'active');
      state = await read(f);
      expect(state.session.status).toBe('running');
      expect(state.sandbox.metadata).not.toHaveProperty('runtimeWakeId');
      expect(state.sandbox.metadata.providerRunningConfirmedAt).toEqual(expect.any(String));
      expect(providerStarts).toBe(1);
      expect(computeReopens).toBe(1);
    } finally {
      onProviderStart = async () => {};
      providerStatus = 'stopped';
    }
  });

  // A manual stop lands while the provider start is still in flight. The stop
  // clears the wake's claim, so the late start must not activate the rows: the
  // wake stops the box it just started instead.
  test('a manual stop wins over a provider start that resolves after it', async () => {
    const { f, row, releaseStart } = await stoppedFixture();
    try {
      expect(await resumeStoppedSandbox(row)).toBe(true);
      await until(() => providerStarts > 0);
      await applyStoppedState({
        sandboxId: f.sandboxId,
        sessionId: f.sessionId,
        externalId: f.externalId,
        stopReason: 'manual',
        metadata: { stoppedBy: 'user-1' },
      });

      providerStatus = 'running';
      releaseStart();
      await until(() => providerStops === 1);
      const { session, sandbox } = await read(f);
      expect(session.status).toBe('stopped');
      expect(sandbox.status).toBe('stopped');
      expect(sandbox.metadata.stopReason).toBe('manual');
      expect(computeReopens).toBe(0);
    } finally {
      onProviderStart = async () => {};
      providerStatus = 'stopped';
    }
  });
});

describe('in-place restart claim', () => {
  const claimFor = (f: Fixture) => {
    const startedAt = new Date();
    return claimInPlaceRestart({
      sandboxId: f.sandboxId,
      externalId: f.externalId,
      claim: {
        id: crypto.randomUUID(),
        startedAt,
        leaseExpiresAt: new Date(startedAt.getTime() + 240_000),
      },
    });
  };

  test('claims an active row and moves it to provisioning', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    expect(await claimFor(f)).toBe(true);
    const { sandbox } = await read(f);
    expect(sandbox.status).toBe('provisioning');
    expect(typeof sandbox.metadata.runtimeRestartId).toBe('string');
    // The unexpired claim fences a second restart, and keeps its own id.
    expect(await claimFor(f)).toBe(false);
    expect((await read(f)).sandbox.metadata.runtimeRestartId).toBe(
      sandbox.metadata.runtimeRestartId,
    );
  });

  test('never claims the archived row of a deleted session', async () => {
    const f = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'archived',
      sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
    });
    expect(await claimFor(f)).toBe(false);
    expect((await read(f)).sandbox.status).toBe('archived');
  });

  test('never claims a row under a live stop claim, and claims it once the claim lapses', async () => {
    const f = await fixture({
      sessionStatus: 'running',
      sandboxStatus: 'active',
      sandboxMetadata: { lifecycleStopClaim: { token: 'stop-1', claimedAtMs: Date.now() } },
    });
    expect(await claimFor(f)).toBe(false);
    expect((await read(f)).sandbox.status).toBe('active');
    await concurrentMetadataWrite(f, { lifecycleStopClaim: { token: 'stop-1', claimedAtMs: 0 } });
    expect(await claimFor(f)).toBe(true);
  });
});

describe('first provisioning (session-sandbox writers)', () => {
  test('a failed create attempt never revives the archived row of a deleted session', async () => {
    const f = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'archived',
      sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
    });
    expect(await transitionSandbox('reprovision', f.sandboxId)).toBeNull();
    expect(await transitionSandbox('failProvisioning', f.sandboxId)).toBeNull();
    expect(await transitionSession('fail', f.sessionId, { error: 'create failed' })).toBe(false);
    const { session, sandbox } = await read(f);
    expect(sandbox.status).toBe('archived');
    expect(session.status).toBe('stopped');
    expect(session.error).toBeNull();
  });

  test('the last attempt writes `error`, and a failover takes the row back to provisioning', async () => {
    const f = await fixture({
      sessionStatus: 'provisioning',
      sandboxStatus: 'provisioning',
      withoutExternalId: true,
    });
    expect(await transitionSandbox('failProvisioning', f.sandboxId)).not.toBeNull();
    // The final failure record lands on the row the last attempt marked.
    expect(await transitionSandbox('failProvisioning', f.sandboxId)).not.toBeNull();
    const failedOver = await transitionSandbox('reprovision', f.sandboxId, {
      columns: { provider: 'e2b' },
    });
    expect(failedOver?.status).toBe('provisioning');
    expect(failedOver?.provider).toBe('e2b');
  });

  test('`provisioned` flips only a session still being provisioned, and sets its URL', async () => {
    const f = await fixture({ sessionStatus: 'provisioning', sandboxStatus: 'active' });
    expect(
      await transitionSession('provisioned', f.sessionId, { sandboxUrl: 'https://box.test' }),
    ).toBe(true);
    const [session] = rows(
      await db.execute(sql`
        select status, sandbox_url from kortix.project_sessions where session_id = ${f.sessionId}`),
    );
    expect(session).toEqual({ status: 'running', sandbox_url: 'https://box.test' });
    const stopped = await fixture({ sessionStatus: 'stopped', sandboxStatus: 'active' });
    expect(await transitionSession('provisioned', stopped.sessionId)).toBe(false);
  });
});

describe('the transition module against real rows', () => {
  // Every session status. A dead-lettered `failed` session keeps its park: a
  // delivery that woke it would aim a reuse trigger back at a wedged session.
  test.each([
    ['stopped', true],
    ['completed', true],
    ['running', false],
    ['provisioning', false],
    ['failed', false],
    ['queued', false],
    ['branching', false],
  ] as const)('`wake` from %s applies: %p', async (from, applies) => {
    const f = await fixture({ sessionStatus: from, sandboxStatus: 'stopped' });
    expect(await transitionSession('wake', f.sessionId, { error: null })).toBe(applies);
    expect((await read(f)).session.status).toBe(applies ? 'running' : from);
  });

  test('`wake` refuses a session deleted after the caller read it', async () => {
    const f = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'archived',
      sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
    });
    expect(await transitionSession('wake', f.sessionId)).toBe(false);
    expect((await read(f)).session.status).toBe('stopped');
  });

  test('`fail` keeps the first dead-letter error and skips a deleted session', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    expect(await transitionSession('fail', f.sessionId, { error: 'first' })).toBe(true);
    expect(await transitionSession('fail', f.sessionId, { error: 'second' })).toBe(false);
    expect((await read(f)).session.error).toBe('first');

    const deleted = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'archived',
      sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
    });
    expect(await transitionSession('fail', deleted.sessionId, { error: 'x' })).toBe(false);
  });

  // A deleted session only ever moves toward `stopped`, and these three writes
  // are the ones that must still reach it: otherwise a deleted session that
  // still reads `running` holds a concurrent-session slot for ever.
  test.each(['delete', 'stop', 'reconcileStuck'] as const)(
    '`%s` stops a deleted session that still reads running',
    async (transition) => {
      const f = await fixture({
        sessionStatus: 'running',
        sandboxStatus: 'archived',
        sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
      });
      expect(await transitionSession(transition, f.sessionId)).toBe(true);
      expect((await read(f)).session.status).toBe('stopped');
    },
  );

  test('`reconcileStuck` does not apply to a session that is no longer active', async () => {
    const f = await fixture({ sessionStatus: 'stopped', sandboxStatus: 'stopped' });
    expect(await transitionSession('reconcileStuck', f.sessionId)).toBe(false);
  });

  test('`delete` merges the tombstone into the session metadata', async () => {
    const f = await fixture({
      sessionStatus: 'running',
      sandboxStatus: 'active',
      sessionMetadata: { title: 'kept' },
    });
    expect(
      await transitionSession('delete', f.sessionId, {
        metadata: { deletedAt: '2026-09-25T12:00:00.000Z', deletedBy: 'user-1' },
      }),
    ).toBe(true);
    const { session } = await read(f);
    expect(session.status).toBe('stopped');
    expect(session.metadata).toMatchObject({
      title: 'kept',
      deletedAt: '2026-09-25T12:00:00.000Z',
      deletedBy: 'user-1',
    });
  });

  test('a restart finalize after the delete archived the row does not apply', async () => {
    const f = await fixture({
      sessionStatus: 'provisioning',
      sandboxStatus: 'provisioning',
      sandboxMetadata: { runtimeRestartId: 'restart-1' },
    });
    await transitionSession('delete', f.sessionId, { metadata: { deletedAt: 'now' } });
    expect(await transitionSandbox('archive', f.sandboxId)).not.toBeNull();
    expect(await transitionSandbox('activate', f.sandboxId)).toBeNull();
    expect(await transitionSession('resume', f.sessionId)).toBe(false);
    const { session, sandbox } = await read(f);
    expect(sandbox.status).toBe('archived');
    expect(session.status).toBe('stopped');
  });

  test('transitionRuntime rolls the session back when the sandbox write loses', async () => {
    const f = await fixture({ sessionStatus: 'running', sandboxStatus: 'active' });
    const row = await transitionRuntime({
      sessionId: f.sessionId,
      sandboxId: f.sandboxId,
      session: 'park',
      sandbox: 'stop',
      at: new Date(),
      error: 'should not land',
      guard: sql`false`,
    });
    expect(row).toBeNull();
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('running');
    expect(session.error).toBeNull();
    expect(sandbox.status).toBe('active');
  });
});

describe('manual stop (stopSession)', () => {
  // The stop reads the row, powers the box off, then writes. Anything another
  // writer put in the metadata during the provider call must survive: the
  // SS6 incident rebuilt the metadata from the row read before the call.
  test('parks an active box as a manual stop by this user, keeping a key written during the provider stop', async () => {
    const f = await fixture({
      sessionStatus: 'running',
      sandboxStatus: 'active',
      sandboxMetadata: { lastAliveAt: 'before-stop' },
    });
    onProviderStop = () => concurrentMetadataWrite(f, { lastAliveAt: 'during-stop' });
    try {
      const result = await stopSession({
        projectId: project.project_id,
        sessionId: f.sessionId,
        accountId: project.account_id,
        userId: 'user-1',
      });
      expect(result).toEqual({
        status: 200,
        body: { ok: true, session_id: f.sessionId, status: 'stopped' },
      });
    } finally {
      onProviderStop = async () => {};
    }
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('stopped');
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.metadata).toMatchObject({
      stopReason: 'manual',
      stoppedBy: 'user-1',
      lastAliveAt: 'during-stop',
    });
  });

  // The row is already `stopped` while a wake is in flight. The stop cancels
  // the wake, and the guard window keeps a provider start that lands late
  // from leaving a running box behind a stopped row.
  test('cancels an in-flight wake on a stopped row and records the late-start guard', async () => {
    const f = await fixture({
      sessionStatus: 'stopped',
      sandboxStatus: 'stopped',
      sandboxMetadata: {
        runtimeWakeId: 'wake-in-flight',
        runtimeWakeStartedAt: new Date().toISOString(),
        runtimeWakeLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    });
    const before = Date.now();
    const stopsBefore = providerStops;

    const result = await stopSession({
      projectId: project.project_id,
      sessionId: f.sessionId,
      accountId: project.account_id,
      userId: 'user-1',
    });

    expect(result.status).toBe(200);
    expect(providerStops).toBe(stopsBefore + 1);
    const { sandbox } = await read(f);
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.metadata.stoppedBy).toBe('user-1');
    expect(sandbox.metadata).not.toHaveProperty('runtimeWakeId');
    expect(Date.parse(sandbox.metadata.runtimeWakeCleanupUntilAt as string)).toBeGreaterThanOrEqual(
      before + RUNTIME_WAKE_LATE_START_GUARD_MS,
    );
  });
});

describe('delete (deleteSession)', () => {
  async function waitForRemovalOutcome(f: Fixture): Promise<Row> {
    for (let i = 0; i < 100; i += 1) {
      const { metadata } = (await read(f)).sandbox;
      if ('providerRemovedAt' in metadata || 'providerRemovalAttempts' in metadata) return metadata;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the provider removal never recorded an outcome');
  }

  async function deleteFixture(): Promise<Fixture> {
    const f = await fixture({
      sessionStatus: 'running',
      sandboxStatus: 'active',
      sandboxMetadata: {
        runtimeRestartId: 'restart-1',
        runtimeRestartLeaseExpiresAt: '2099-01-01T00:00:00.000Z',
        runtimeWakeId: 'wake-1',
        runtimeRecoveryLeaseId: 'recovery-1',
      },
    });
    // Written by another writer after any read the route made.
    await concurrentMetadataWrite(f, { egressPin: 'pin-1' });
    return f;
  }

  const runDelete = (f: Fixture) =>
    deleteSession({
      projectId: project.project_id,
      sessionId: f.sessionId,
      accountId: project.account_id,
      userId: 'user-1',
    });

  // The archive strips every lifecycle fence, so a detached restart, wake or
  // recovery loses its finalize CAS instead of flipping the row back to
  // `active`. The removal intent is recorded in the same write, and only a
  // confirmed removal clears it.
  test('archives the row without its fences, and a confirmed removal clears the intent', async () => {
    const f = await deleteFixture();
    onProviderRemove = async () => {};

    expect(await runDelete(f)).toEqual({ ok: true });

    const { session, sandbox } = await read(f);
    expect(session.status).toBe('stopped');
    expect(session.metadata).toMatchObject({ deletedBy: 'user-1' });
    expect(sandbox.status).toBe('archived');
    for (const key of ['runtimeRestartId', 'runtimeWakeId', 'runtimeRecoveryLeaseId']) {
      expect(sandbox.metadata).not.toHaveProperty(key);
    }
    expect(sandbox.metadata.egressPin).toBe('pin-1');
    const removed = await waitForRemovalOutcome(f);
    expect(typeof removed.providerRemovedAt).toBe('string');
    expect(removed).not.toHaveProperty('providerRemovalPendingAt');
  });

  test('a refused removal keeps the intent and schedules a retry', async () => {
    const f = await deleteFixture();
    providerStatus = 'stopped';
    onProviderRemove = async () => {
      throw new Error('sandbox is transitioning');
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      await runDelete(f);
      const failed = await waitForRemovalOutcome(f);
      expect(failed.providerRemovalAttempts).toBe(1);
      expect(Date.parse(failed.providerRemovalRetryAfterAt as string)).toBeGreaterThan(Date.now());
      expect(typeof failed.providerRemovalPendingAt).toBe('string');
      expect(failed).not.toHaveProperty('providerRemovedAt');
    } finally {
      console.warn = warn;
      onProviderRemove = async () => {};
    }
  });

  test('a remove that fails because the box is already gone counts as removed', async () => {
    const f = await deleteFixture();
    providerStatus = 'removed';
    onProviderRemove = async () => {
      throw new Error('sandbox not found');
    };
    try {
      await runDelete(f);
      const removed = await waitForRemovalOutcome(f);
      expect(typeof removed.providerRemovedAt).toBe('string');
      expect(removed).not.toHaveProperty('providerRemovalPendingAt');
    } finally {
      providerStatus = 'stopped';
      onProviderRemove = async () => {};
    }
  });
});
