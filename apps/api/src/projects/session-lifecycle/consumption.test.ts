import { describe, expect, test } from 'bun:test';
import { DEDUPE_TTL_MS } from '../../sandbox-proxy/prompt-dedupe';
import {
  type ConsumptionDeps,
  type ForwardedPromptRow,
  INBOX_FORWARD_CONFIRM_GRACE_MS,
  INBOX_FORWARD_CONFIRM_MAX_MS,
  confirmInboxPromptConsumed,
  reconcileForwardedPrompts,
} from './consumption';

interface Row {
  commandId: string;
  sessionId: string;
  status: string;
  result: Record<string, unknown>;
  payload: Record<string, unknown>;
  updatedAt: Date;
}

/**
 * The id half of the real `where`, mirroring `wire-id-match.ts`'s
 * `wireMessageIdMatches` — ALL THREE columns a wire id can be recorded in.
 *
 * `result.forwarded_message_id` is the one this harness (and the statement it
 * mirrors) used to omit. `markCommandForwarded` (`store.ts:518`) writes the id
 * the delivery ACTUALLY used there, which is not required to equal either
 * payload id, so a row could be named by an id no payload column held and this
 * module would never close it — the strip read `delivering` for ever.
 *
 * This is a MIRROR, so it can drift from the statement again. What stops that
 * is `wire-id-match.test.ts`, which pins the compiled SQL and asserts every
 * reader calls the one helper.
 */
function namesRow(row: Row, wireMessageId: string): boolean {
  return (
    row.payload.wireMessageId === wireMessageId ||
    row.payload.redeliveredMessageId === wireMessageId ||
    row.result.forwarded_message_id === wireMessageId
  );
}

/**
 * A stand-in for the statements this module runs. `confirm` and
 * `markConsumedOnDelivery` re-express their UPDATEs' own predicates as row
 * filters, so a confirmation that forgets its `status='succeeded'` /
 * `forwarded` guard — or a delivery mark that forgets `status='running'` —
 * changes an answer below.
 */
function harness(
  rows: Row[],
  ledger: Record<string, { state: string; endReason: string | null }> = {},
) {
  const confirmed: string[] = [];
  const marked: string[] = [];
  const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const deps: ConsumptionDeps = {
    markConsumedOnDelivery: async (sessionId, wireMessageId) => {
      const hit = rows.filter(
        (r) =>
          r.sessionId === sessionId &&
          r.status === 'running' &&
          namesRow(r, wireMessageId),
      );
      for (const r of hit) {
        r.payload = { ...r.payload, consumedOnDelivery: true };
        marked.push(r.commandId);
      }
      return hit.length;
    },
    confirm: async (sessionId, wireMessageId) => {
      const hit = rows.filter(
        (r) =>
          r.sessionId === sessionId &&
          r.status === 'succeeded' &&
          r.result.status === 'forwarded' &&
          namesRow(r, wireMessageId),
      );
      for (const r of hit) {
        // `|| '{"status":"delivered"}' - 'stop_paused' - 'held'`: the row is
        // closed, so the user's Stop marker goes with it.
        const { stop_paused: _stopped, held: _held, ...kept } = r.result;
        r.result = { ...kept, status: 'delivered' };
        confirmed.push(r.commandId);
      }
      return hit.length;
    },
    listForwarded: async (olderThan, limit) =>
      rows
        .filter(
          (r) =>
            r.status === 'succeeded' &&
            r.result.status === 'forwarded' &&
            r.updatedAt.getTime() <= olderThan.getTime(),
        )
        .slice(0, limit)
        .map(
          (r): ForwardedPromptRow => ({
            commandId: r.commandId,
            sessionId: r.sessionId,
            wireMessageId: (r.payload.wireMessageId as string) ?? null,
            redeliveredMessageId: (r.payload.redeliveredMessageId as string) ?? null,
            updatedAt: r.updatedAt,
          }),
        ),
    readLedgerTurn: async (_sessionId, messageIds) => {
      for (const id of messageIds) if (ledger[id]) return ledger[id];
      return null;
    },
    logForceClosed: (message, context) => errors.push({ message, context }),
  };
  return { deps, confirmed, marked, errors, rows };
}

const forwardedRow = (overrides: Partial<Row> = {}): Row => ({
  commandId: 'cmd-1',
  sessionId: 'sess-1',
  status: 'succeeded',
  result: { status: 'forwarded', forwarded_message_id: 'msg_a' },
  payload: { text: 'hi', clientMessageId: 'q_1', wireMessageId: 'msg_a' },
  updatedAt: new Date('2026-08-18T00:00:00.000Z'),
  ...overrides,
});

describe('confirmInboxPromptConsumed', () => {
  test('a turn that consumed the wire id closes the row', async () => {
    const { deps, rows, confirmed } = harness([forwardedRow()]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_a', deps)).toBe('confirmed');
    expect(confirmed).toEqual(['cmd-1']);
    expect(rows[0].result).toEqual({ status: 'delivered', forwarded_message_id: 'msg_a' });
  });

  test('the RE-MINTED id of a redelivery names the same row', async () => {
    // Every reader shares ONE predicate (`wire-id-match.ts`), so none of them
    // can disagree about which row an id names.
    const { deps, confirmed } = harness([
      forwardedRow({
        payload: { text: 'hi', wireMessageId: 'msg_a', redeliveredMessageId: 'msg_b' },
      }),
    ]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_b', deps)).toBe('confirmed');
    expect(confirmed).toEqual(['cmd-1']);
  });

  // REGRESSION 2026-08-20. Before the predicate was single-sourced this row
  // was invisible here: `forwarded_message_id` records the id the delivery
  // ACTUALLY went out under, and it matches NEITHER payload id. The acceptance
  // relay named `msg_c`, `confirm` matched no row, and the row stayed
  // `forwarded` — the composer's strip read "delivering" until the max-age
  // sweep force-closed it ~10 min later.
  test('a row whose forwarded id differs from BOTH payload ids still closes', async () => {
    const { deps, rows, confirmed } = harness([
      forwardedRow({
        payload: { text: 'hi', clientMessageId: 'q_1', wireMessageId: 'msg_a', redeliveredMessageId: 'msg_b' },
        result: { status: 'forwarded', forwarded_message_id: 'msg_c' },
      }),
    ]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_c', deps)).toBe('confirmed');
    expect(confirmed).toEqual(['cmd-1']);
    expect(rows[0].result).toEqual({ status: 'delivered', forwarded_message_id: 'msg_c' });
  });

  test('an id NO column on the row holds still names nothing', async () => {
    const { deps, confirmed } = harness([
      forwardedRow({
        payload: { text: 'hi', clientMessageId: 'q_1', wireMessageId: 'msg_a' },
        result: { status: 'forwarded', forwarded_message_id: 'msg_c' },
      }),
    ]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_zzz', deps)).not.toBe('confirmed');
    expect(confirmed).toEqual([]);
  });

  test('a QUEUED row is left alone — it has not been forwarded', async () => {
    const { deps, confirmed } = harness([forwardedRow({ status: 'queued', result: {} })]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_a', deps)).toBe('no_prompt');
    expect(confirmed).toEqual([]);
  });

  test('an already-delivered row is a no-op, so the call is idempotent', async () => {
    // Both witnesses can fire for one prompt (acceptance, then completion) and
    // the reconciler can arrive on top of either.
    const { deps, confirmed } = harness([forwardedRow({ result: { status: 'delivered' } })]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_a', deps)).toBe('no_prompt');
    expect(confirmed).toEqual([]);
  });

  test('closing a STOP-PAUSED row drops the marker the release re-queues on', async () => {
    // The row is finished — a turn consumed the message — so nothing about it
    // is still waiting on the user. Leaving `stop_paused` behind is what let
    // the next send re-queue a prompt that had already been answered.
    const { deps, rows } = harness([
      forwardedRow({ result: { status: 'forwarded', stop_paused: true, held: true } }),
    ]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_a', deps)).toBe('confirmed');
    expect(rows[0].result).toEqual({ status: 'delivered' });
  });

  test('acceptance reaches a row the drain has NOT marked forwarded yet', async () => {
    // THE ORDER THIS FUNCTION ACTUALLY RUNS IN. Acceptance happens INSIDE the
    // POST — `forwardToSandbox` awaits `acceptSandboxTurn` before it returns —
    // and `markCommandForwarded` runs only after `continueSession` returns. So
    // at acceptance the row is still `running`, and a confirmation that only
    // matched `succeeded` + `forwarded` matched nothing on the one path every
    // composer prompt takes.
    //
    // The delivery cannot be closed from here (the drain still owns the row and
    // is about to write its result), so the fact is left in the PAYLOAD for
    // `markCommandForwarded` to land — the same merged-payload channel
    // `stopPausedOnDelivery` uses, and for the same reason.
    const { deps, rows, confirmed, marked } = harness([
      forwardedRow({ status: 'running', result: {} }),
    ]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_a', deps)).toBe('pending_delivery');
    expect(confirmed).toEqual([]);
    expect(marked).toEqual(['cmd-1']);
    expect(rows[0].payload.consumedOnDelivery).toBe(true);
  });

  test('the RE-MINTED id names the running row too — that is the id on the wire', async () => {
    // A mid-turn prompt is re-minted before the POST, so the id OpenCode
    // accepts is `redeliveredMessageId`, not the client's.
    const { deps, marked } = harness([
      forwardedRow({
        status: 'running',
        result: {},
        payload: { text: 'hi', wireMessageId: 'msg_a', redeliveredMessageId: 'msg_b' },
      }),
    ]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_b', deps)).toBe('pending_delivery');
    expect(marked).toEqual(['cmd-1']);
  });

  test('a forwarded row is CLOSED, not marked — the drain is done with it', async () => {
    const { deps, confirmed, marked } = harness([forwardedRow()]);
    expect(await confirmInboxPromptConsumed('sess-1', 'msg_a', deps)).toBe('confirmed');
    expect(confirmed).toEqual(['cmd-1']);
    expect(marked).toEqual([]);
  });

  test('no wire id means no row to key on — automation prompts carry none', async () => {
    const { deps, confirmed } = harness([forwardedRow()]);
    expect(await confirmInboxPromptConsumed('sess-1', null, deps)).toBe('no_prompt');
    expect(confirmed).toEqual([]);
  });

  test('a failed confirmation never throws — it is bookkeeping over an authority write', async () => {
    const { deps } = harness([forwardedRow()]);
    expect(
      await confirmInboxPromptConsumed('sess-1', 'msg_a', {
        ...deps,
        confirm: async () => {
          throw new Error('db down');
        },
      }),
    ).toBe('no_prompt');
  });
});

describe('reconcileForwardedPrompts', () => {
  const now = new Date('2026-08-18T01:00:00.000Z');
  const aged = (ms: number) => new Date(now.getTime() - ms);

  test('a row younger than the grace is not even looked at', async () => {
    const { deps, confirmed } = harness([
      forwardedRow({ updatedAt: aged(INBOX_FORWARD_CONFIRM_GRACE_MS - 1_000) }),
    ]);
    expect(await reconcileForwardedPrompts(now, deps)).toEqual({
      scanned: 0,
      confirmed: 0,
      forceClosed: 0,
    });
    expect(confirmed).toEqual([]);
  });

  test('an ACTIVE ledger turn proves the prompt was consumed', async () => {
    const { deps, confirmed } = harness([forwardedRow({ updatedAt: aged(60_000) })], {
      msg_a: { state: 'active', endReason: null },
    });
    expect(await reconcileForwardedPrompts(now, deps)).toEqual({
      scanned: 1,
      confirmed: 1,
      forceClosed: 0,
    });
    expect(confirmed).toEqual(['cmd-1']);
  });

  test('a turn that ENDED completed or failed proves it too', async () => {
    for (const endReason of ['completed', 'failed']) {
      const { deps, confirmed } = harness([forwardedRow({ updatedAt: aged(60_000) })], {
        msg_a: { state: 'ended', endReason },
      });
      expect((await reconcileForwardedPrompts(now, deps)).confirmed).toBe(1);
      expect(confirmed).toEqual(['cmd-1']);
    }
  });

  test('a NEVER-RAN ending is left for the redelivery that owns it', async () => {
    // `requeueAbandonedPrompt` flips exactly these rows back to `queued`, which
    // takes them out of this scan. Confirming here would race it and close a
    // prompt that is about to be sent again.
    const { deps, confirmed } = harness([forwardedRow({ updatedAt: aged(60_000) })], {
      msg_a: { state: 'ended', endReason: 'runtime_gone' },
    });
    expect(await reconcileForwardedPrompts(now, deps)).toEqual({
      scanned: 1,
      confirmed: 0,
      forceClosed: 0,
    });
    expect(confirmed).toEqual([]);
  });

  test('a never-ran ending nobody came back for is force-closed at the ceiling', async () => {
    // The reaper only redelivers when the daemon proves a prompt was ORPHANED.
    // A turn closed `unknown` because a newer prompt took the root (the
    // measured mid-turn case) is never redelivered, so waiting for
    // `requeueAbandonedPrompt` forever would strand the row as `delivering`.
    const { deps, confirmed, errors } = harness(
      [forwardedRow({ updatedAt: aged(INBOX_FORWARD_CONFIRM_MAX_MS + 1_000) })],
      { msg_a: { state: 'ended', endReason: 'unknown' } },
    );
    expect(await reconcileForwardedPrompts(now, deps)).toEqual({
      scanned: 1,
      confirmed: 0,
      forceClosed: 1,
    });
    expect(confirmed).toEqual(['cmd-1']);
    expect(errors).toHaveLength(1);
  });

  test('NO ledger row at all is force-closed past the ceiling, and logged', async () => {
    // Every ledger write is a best-effort SECOND round trip whose failure
    // `recordTurnLedger` swallows, so "no row" proves nothing — and a strip
    // that says `delivering` for ever is worse than a logged unknown.
    const { deps, confirmed, errors } = harness([
      forwardedRow({ updatedAt: aged(INBOX_FORWARD_CONFIRM_MAX_MS + 1_000) }),
    ]);
    expect(await reconcileForwardedPrompts(now, deps)).toEqual({
      scanned: 1,
      confirmed: 0,
      forceClosed: 1,
    });
    expect(confirmed).toEqual(['cmd-1']);
    expect(errors[0].context).toMatchObject({ command_id: 'cmd-1', session_id: 'sess-1' });
  });

  test('no ledger row INSIDE the ceiling is left alone — the write may still land', async () => {
    const { deps, confirmed } = harness([forwardedRow({ updatedAt: aged(60_000) })]);
    expect(await reconcileForwardedPrompts(now, deps)).toEqual({
      scanned: 1,
      confirmed: 0,
      forceClosed: 0,
    });
    expect(confirmed).toEqual([]);
  });

  test('the sweep NEVER redelivers — it only ever closes rows', async () => {
    // Redelivery stays the reaper's job, because only the reaper holds the
    // daemon's proof that a turn never ran. Nothing here may put a row back on
    // the queue, so no shape of ledger evidence can produce a `queued` row.
    const { deps, rows } = harness(
      [
        forwardedRow({ commandId: 'a', updatedAt: aged(60_000) }),
        forwardedRow({
          commandId: 'b',
          payload: { wireMessageId: 'msg_b' },
          updatedAt: aged(INBOX_FORWARD_CONFIRM_MAX_MS + 1),
        }),
      ],
      { msg_a: { state: 'ended', endReason: 'abandoned' } },
    );
    await reconcileForwardedPrompts(now, deps);
    expect(rows.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
  });

  test('a ledger turn still DELIVERING is left open past the ceiling', async () => {
    // THE flagship mid-turn case. `beginSandboxTurn` opens a `delivering`
    // record at delivery time, and it stays that way for as long as OpenCode
    // holds the message behind the turn in front of it — the p99 turn is ~78
    // min, eight times this ceiling. Force-closing there deletes a message from
    // the user's queue while OpenCode is still going to run it, and pages
    // on-call for a completely healthy flow.
    //
    // The wait is bounded by the LEDGER, not by this sweep: when the box parks
    // or dies, the reaper ends the record with a never-ran reason and the
    // branches above close the row.
    const { deps, confirmed, errors } = harness(
      [forwardedRow({ updatedAt: aged(INBOX_FORWARD_CONFIRM_MAX_MS + 60_000) })],
      { msg_a: { state: 'delivering', endReason: null } },
    );
    expect(await reconcileForwardedPrompts(now, deps)).toEqual({
      scanned: 1,
      confirmed: 0,
      forceClosed: 0,
    });
    expect(confirmed).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the force-close ceiling IS the proxy dedupe TTL, by import', async () => {
    // Not a second hardcoded 10 minutes: past this window the delivery claim
    // that would absorb a duplicate POST has expired anyway, so "we still
    // cannot tell" has stopped being a state worth preserving.
    expect(INBOX_FORWARD_CONFIRM_MAX_MS).toBe(DEDUPE_TTL_MS);
    // And the grace matches the reaper's own "accepted but not started yet"
    // window (`ORPHANED_PROMPT_MIN_AGE_MS`).
    expect(INBOX_FORWARD_CONFIRM_GRACE_MS).toBe(30_000);
  });
});
