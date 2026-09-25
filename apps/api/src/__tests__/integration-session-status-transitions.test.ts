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
import * as realProviders from '../platform/providers';
import { db } from '../shared/db';

let providerStops = 0;
/** What the provider stop does besides counting. Reset after each park case. */
let onProviderStop: () => Promise<void> = async () => {};
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    stop: async () => {
      providerStops += 1;
      await onProviderStop();
    },
  }),
}));

const { applyStoppedState } = await import('../projects/reaping/sandbox-state-sync');
const {
  claimInPlaceRuntimeRecovery,
  markInPlaceRuntimeRecoveryAccepted,
  parkEstablishedRuntime,
  preserveEstablishedRuntime,
} = await import('../projects/runtime-identity');
const { claimInPlaceRestart } = await import('../projects/session-lifecycle/runtime-restart-claim');
const { transitionRuntime, transitionSandbox, transitionSession } = await import(
  '../projects/session-lifecycle/status-transitions'
);

type Row = Record<string, unknown>;
const rows = (result: unknown) => ((result as { rows?: Row[] }).rows ?? result) as Row[];

let project: { project_id: string; account_id: string };
const created: string[] = [];

interface Fixture {
  sessionId: string;
  sandboxId: string;
  externalId: string;
}

async function fixture(input: {
  sessionStatus: string;
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
      (session_id, account_id, project_id, branch_name, agent_name, status, metadata)
    values
      (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, ${sessionId},
       'default', ${input.sessionStatus}::kortix.project_session_status,
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
  session: { status: string; error: string | null; metadata: Row };
  sandbox: { status: string; metadata: Row; updated_at: Date } & Row;
}> {
  const [session] = rows(
    await db.execute(sql`
      select status, error, metadata from kortix.project_sessions where session_id = ${f.sessionId}`),
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
  const [first] = rows(
    await db.execute(
      sql`select project_id, account_id from kortix.projects order by created_at asc limit 1`,
    ),
  );
  project = first as typeof project;
  expect(project).toBeDefined();
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
});

describe('stop (applyStoppedState)', () => {
  test('parks an active box and its running session, merging the patch', async () => {
    const f = await fixture({
      sessionStatus: 'running',
      sandboxStatus: 'active',
      sandboxMetadata: {
        lastAliveAt: '2026-09-25T10:00:00.000Z',
        runtimeWakeId: 'wake-1',
        activeTurns: {},
        pendingStopObservedAtMs: 1,
      },
    });
    await applyStoppedState({
      sandboxId: f.sandboxId,
      sessionId: f.sessionId,
      externalId: f.externalId,
      stopReason: 'manual',
      metadata: { stoppedBy: 'user-1' },
    });
    const { session, sandbox } = await read(f);
    expect(session.status).toBe('stopped');
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.metadata.stopReason).toBe('manual');
    expect(sandbox.metadata.stoppedBy).toBe('user-1');
    expect(sandbox.metadata.lastAliveAt).toBe('2026-09-25T10:00:00.000Z');
    expect(sandbox.metadata).not.toHaveProperty('runtimeWakeId');
    expect(sandbox.metadata).not.toHaveProperty('activeTurns');
    expect(sandbox.metadata).not.toHaveProperty('pendingStopObservedAtMs');
  });

  test('keeps a dead-lettered `failed` session failed', async () => {
    const f = await fixture({ sessionStatus: 'failed', sandboxStatus: 'active' });
    await applyStoppedState({
      sandboxId: f.sandboxId,
      sessionId: f.sessionId,
      externalId: f.externalId,
      stopReason: 'deadline_expired',
    });
    const { session, sandbox } = await read(f);
    expect(sandbox.status).toBe('stopped');
    expect(session.status).toBe('failed');
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
    let claimDuringStop = undefined as Record<string, unknown> | undefined;
    onProviderStop = async () => {
      claimDuringStop = (await read(f)).sandbox.metadata.lifecycleStopClaim as
        | Record<string, unknown>
        | undefined;
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
    // The claim `beginSandboxTurn` refuses a prompt on.
    expect(claimDuringStop).toMatchObject({ token: expect.any(String) });
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
    expect(await claimFor(f)).toBe(false);
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
  test('`wake` moves a stopped session, and only a stopped or completed one', async () => {
    const stopped = await fixture({ sessionStatus: 'stopped', sandboxStatus: 'stopped' });
    expect(await transitionSession('wake', stopped.sessionId, { error: null })).toBe(true);
    expect((await read(stopped)).session.status).toBe('running');
    // Already running: the transition does not apply.
    expect(await transitionSession('wake', stopped.sessionId)).toBe(false);
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

  test('`reconcileStuck` stops a deleted session that still reads running', async () => {
    const f = await fixture({
      sessionStatus: 'running',
      sandboxStatus: 'archived',
      sessionMetadata: { deletedAt: '2026-09-25T10:00:00.000Z' },
    });
    expect(await transitionSession('reconcileStuck', f.sessionId)).toBe(true);
    expect((await read(f)).session.status).toBe('stopped');
    // Not an active status any more.
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
