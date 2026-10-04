import { describe, expect, test } from 'bun:test';

import {
  DIVERGENCE_SETTLE_GRACE_MS,
  type DivergenceRow,
  closeRowVmDivergence,
  decideRowVmDivergence,
  selectDivergedBoxes,
} from './row-vm-divergence';

/**
 * A row in `session_sandboxes` and the provider's VM must never disagree.
 *
 * The direction this file owns is ROW PARKED / VM RUNNING. It is the one
 * nothing walked: the box reaper's candidate predicate is `status = 'active'`
 * (box-queries.ts), and the parked sweep reads a running box as "still there"
 * and rotates on (parked-runtime-verification.ts).
 *
 * It is not cosmetic. A session credential is refused whenever its sandbox row
 * is not `provisioning`/`active` (services/repositories/account-tokens.ts), so a wrong
 * `stopped` row kills the live box's own credential: every call it makes to the
 * API answers 401, its runtime assets can never converge, and the daemon's
 * dead-token breaker shuts the daemon down with exit 0 — which the Platinum
 * entrypoint reads as an intentional stop and never relaunches.
 */
describe('decideRowVmDivergence', () => {
  const settled = DIVERGENCE_SETTLE_GRACE_MS + 1;
  const base = {
    rowStatus: 'stopped' as const,
    transitionInProgress: false,
    ownedByThisInstance: true,
    rowSettledForMs: settled,
  };

  test('a parked row over a running VM is closed by stopping the VM', () => {
    expect(decideRowVmDivergence(base)).toBe('stop-vm');
  });

  test('an archived row over a running VM is closed the same way', () => {
    // A deleted session's box. `archived-box-removal.ts` only retries rows that
    // carry a removal-pending stamp, so an archived row without one has nothing
    // watching it and its VM runs unbilled forever.
    expect(decideRowVmDivergence({ ...base, rowStatus: 'archived' })).toBe('stop-vm');
  });

  test('a row that wants the box running is never touched', () => {
    for (const rowStatus of ['active', 'provisioning'] as const) {
      expect(decideRowVmDivergence({ ...base, rowStatus })).toBe('skip');
    }
  });

  test('a live wake or restart owns the row, so the sweep keeps its hands off', () => {
    // Two components acting on one sandbox is how a wake gets cancelled
    // underneath itself — the same fence decideParkedRuntime applies.
    expect(decideRowVmDivergence({ ...base, transitionInProgress: true })).toBe('skip');
  });

  test('another instance on a shared database owns its own rows', () => {
    expect(decideRowVmDivergence({ ...base, ownedByThisInstance: false })).toBe('skip');
  });

  test('a row written moments ago is left to settle', () => {
    // The stop that parked the row and the provider listing that saw it running
    // can be seconds apart. Uncertainty fails toward the live box.
    expect(decideRowVmDivergence({ ...base, rowSettledForMs: 0 })).toBe('skip');
    expect(decideRowVmDivergence({ ...base, rowSettledForMs: DIVERGENCE_SETTLE_GRACE_MS })).toBe(
      'skip',
    );
  });
});

describe('selectDivergedBoxes', () => {
  const box = (externalId: string, provider = 'platinum') => ({ provider, externalId });

  test('pairs each listed running box with the row that claims it', () => {
    const diverged = selectDivergedBoxes(
      [box('sbx-a'), box('sbx-b'), box('sbx-c'), box('sbx-d')],
      [
        { provider: 'platinum', externalId: 'sbx-a', status: 'stopped', sandboxId: 'sb-a' },
        { provider: 'platinum', externalId: 'sbx-b', status: 'active', sandboxId: 'sb-b' },
        { provider: 'platinum', externalId: 'sbx-c', status: 'archived', sandboxId: 'sb-c' },
      ],
    );
    // `sbx-b` is running as intended; `sbx-d` has no row at all and belongs to
    // the orphan sweep, which is the only path allowed to stop an unreferenced
    // box.
    expect(diverged.map((row) => row.sandboxId).sort()).toEqual(['sb-a', 'sb-c']);
  });

  test('a box mid-create is never a candidate, in either layer', () => {
    // THE DANGEROUS FALSE POSITIVE, named. A test suite (or a user) provisions
    // a box; the provider `create` returns and the row is `provisioning` for a
    // moment before it reaches `active`. If that window counted as "row parked,
    // VM running", this sweep would switch off a box somebody is about to use,
    // and every flow holding it would fail for reasons that look nothing like
    // a reaper.
    expect(
      selectDivergedBoxes(
        [box('sbx-a'), box('sbx-b')],
        [
          { provider: 'platinum', externalId: 'sbx-a', status: 'provisioning', sandboxId: 'sb-a' },
          { provider: 'platinum', externalId: 'sbx-b', status: 'active', sandboxId: 'sb-b' },
        ],
      ),
    ).toEqual([]);
    // And the decision re-checks it after the authoritative re-read, so a row
    // that moved between the bulk scan and the decision is judged on what it
    // says NOW, not on what the scan saw.
    for (const rowStatus of ['provisioning', 'active', 'error'] as const) {
      expect(
        decideRowVmDivergence({
          rowStatus,
          transitionInProgress: false,
          ownedByThisInstance: true,
          rowSettledForMs: 24 * 3600_000,
        }),
      ).toBe('skip');
    }
  });

  test('the same external id under a different provider is a different box', () => {
    const diverged = selectDivergedBoxes(
      [box('sbx-a', 'daytona')],
      [{ provider: 'platinum', externalId: 'sbx-a', status: 'stopped', sandboxId: 'sb-a' }],
    );
    expect(diverged).toEqual([]);
  });

  test('every parked row is considered, at any age, with no batch limit', () => {
    // The existing operator sweep filters `lastUsedAt > 7 days` and `--limit
    // 20`. A reconciler with a recency window is not the invariant: the divergence
    // measured on dev had sat for 31.8 days.
    const boxes = Array.from({ length: 500 }, (_, i) => box(`sbx-${i}`));
    const rows = boxes.map((b, i) => ({
      provider: b.provider,
      externalId: b.externalId,
      status: 'stopped',
      sandboxId: `sb-${i}`,
    }));
    expect(selectDivergedBoxes(boxes, rows)).toHaveLength(500);
  });
});

describe('closeRowVmDivergence', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
  const row = (over: Partial<DivergenceRow> = {}): DivergenceRow => ({
    sandboxId: 'sb-1',
    sessionId: 'se-1',
    provider: 'platinum',
    externalId: 'sbx-1',
    status: 'stopped',
    metadata: {},
    updatedAt: minutesAgo(60),
    ...over,
  });
  const listing = [{ provider: 'platinum', externalId: 'sbx-1' }];
  const scan = [
    { provider: 'platinum', externalId: 'sbx-1', status: 'stopped', sandboxId: 'sb-1' },
  ];

  function spyDeps(read: DivergenceRow | null) {
    const stopped: string[] = [];
    const marked: string[] = [];
    return {
      stopped,
      marked,
      deps: {
        readRow: async () => read,
        stopBox: async (_provider: string, externalId: string) => {
          stopped.push(externalId);
        },
        markClosed: async (sandboxId: string) => {
          marked.push(sandboxId);
        },
      },
    };
  }

  test('stops the VM behind a settled parked row and stamps the row', async () => {
    const { deps, stopped, marked } = spyDeps(row());
    expect(await closeRowVmDivergence({ boxes: listing, rows: scan }, deps)).toEqual({
      diverged: 1,
      closed: 1,
      errors: 0,
    });
    expect(stopped).toEqual(['sbx-1']);
    expect(marked).toEqual(['sb-1']);
  });

  test('the re-read is authoritative: a row that went active in between is left alone', async () => {
    // The bulk scan and the provider listing are not one transaction. A
    // `/start` between them is exactly the case that must never be stopped.
    const { deps, stopped } = spyDeps(row({ status: 'active' }));
    expect(await closeRowVmDivergence({ boxes: listing, rows: scan }, deps)).toEqual({
      diverged: 0,
      closed: 0,
      errors: 0,
    });
    expect(stopped).toEqual([]);
  });

  test('a row whose external id no longer matches the listed box is left alone', async () => {
    const { deps, stopped } = spyDeps(row({ externalId: 'sbx-other' }));
    expect((await closeRowVmDivergence({ boxes: listing, rows: scan }, deps)).closed).toBe(0);
    expect(stopped).toEqual([]);
  });

  test('a live wake holds the box, even over a parked row', async () => {
    const { deps, stopped } = spyDeps(
      row({
        metadata: {
          runtimeWakeId: 'wake-1',
          runtimeWakeStartedAt: new Date().toISOString(),
          runtimeWakeLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    );
    expect((await closeRowVmDivergence({ boxes: listing, rows: scan }, deps)).closed).toBe(0);
    expect(stopped).toEqual([]);
  });

  test('a failed stop is counted, never thrown, and the row is not stamped closed', async () => {
    const marked: string[] = [];
    const result = await closeRowVmDivergence(
      { boxes: listing, rows: scan },
      {
        readRow: async () => row(),
        stopBox: async () => {
          throw new Error('provider 503');
        },
        markClosed: async (sandboxId: string) => {
          marked.push(sandboxId);
        },
      },
    );
    expect(result).toEqual({ diverged: 1, closed: 0, errors: 1 });
    expect(marked).toEqual([]);
  });
});
