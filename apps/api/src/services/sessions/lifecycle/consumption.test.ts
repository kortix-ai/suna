import { describe, expect, test } from 'bun:test';
import { DEDUPE_TTL_MS } from '../../sandbox-proxy/prompt-dedupe';
import {
  type ConsumptionDeps,
  type ForwardedPromptRow,
  INBOX_FORWARD_CONFIRM_GRACE_MS,
  INBOX_FORWARD_CONFIRM_MAX_MS,
  INBOX_FORWARD_ORPHAN_MAX_MS,
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
 * This is a MIRROR, so it can drift from the statement. The statement itself
 * is proven on real rows in __tests__/integration-prompt-inbox.test.ts.
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

// Which row a wire id closes, and when, is the SQL of `confirm` and
// `markConsumedOnDelivery`: proven on real rows in
// __tests__/integration-prompt-inbox.test.ts. These rows pin the guards in
// front of it.
describe('confirmInboxPromptConsumed', () => {
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

  test('an `unknown` ending is the SUPERSEDED case — confirmed on the first pass, not the ceiling', async () => {
    // The reaper redelivers ONLY when the daemon proves a prompt ORPHANED, and
    // it does that with `abandoned`/`runtime_gone` — never `unknown`. Box-reaper
    // writes `unknown` for the OTHER terminal: the daemon answered "no turn in
    // flight" but could not classify it because a NEWER user message now owns
    // the root. That prompt's answer is already on screen, and no path will ever
    // requeue it, so an `unknown` row still in the forwarded scan is proof the
    // orphan branch declined it. Confirm it AT ONCE — waiting for the ceiling
    // stranded the badge as "Queued" for up to `INBOX_FORWARD_CONFIRM_MAX_MS`.
    const { deps, confirmed, errors } = harness(
      [forwardedRow({ updatedAt: aged(60_000) })],
      { msg_a: { state: 'ended', endReason: 'unknown' } },
    );
    expect(await reconcileForwardedPrompts(now, deps)).toEqual({
      scanned: 1,
      confirmed: 1,
      forceClosed: 0,
    });
    expect(confirmed).toEqual(['cmd-1']);
    // A healthy supersede, not a lost prompt: closing it raises no error log.
    expect(errors).toEqual([]);
  });

  test('`abandoned`/`runtime_gone` still WAIT for the requeue — they are the orphan reasons', async () => {
    // These are exactly the reasons `requeueAbandonedPrompt` flips to `queued`,
    // which takes the row out of this scan. Confirming one early would race the
    // redelivery and close a prompt that is about to be sent again, so an
    // orphan reason is left alone until the ceiling force-closes it.
    for (const endReason of ['abandoned', 'runtime_gone']) {
      const { deps, confirmed, errors } = harness(
        [forwardedRow({ updatedAt: aged(60_000) })],
        { msg_a: { state: 'ended', endReason } },
      );
      expect(await reconcileForwardedPrompts(now, deps)).toEqual({
        scanned: 1,
        confirmed: 0,
        forceClosed: 0,
      });
      expect(confirmed).toEqual([]);
      expect(errors).toEqual([]);
    }
  });

  test('an orphan ending PAST its own bound is force-closed — the sticky "Queued" badge', async () => {
    // The other half of the rule above. `requeueAbandonedPrompt` acts on these
    // reasons in the same reaping cycle that produced the terminal evidence, so
    // a row still forwarded well past that cycle is one the redelivery
    // DECLINED. Left alone it kept reading `delivering`, which
    // `countLiveInboxPrompts` counts as live work: the composer held Stop with
    // nothing running and the bubble kept its "Queued" badge, both across a
    // hard refresh (measured locally — see the constant's note).
    for (const endReason of ['abandoned', 'runtime_gone']) {
      const { deps, confirmed, errors } = harness(
        [forwardedRow({ updatedAt: aged(INBOX_FORWARD_ORPHAN_MAX_MS + 1_000) })],
        { msg_a: { state: 'ended', endReason } },
      );
      expect(await reconcileForwardedPrompts(now, deps)).toEqual({
        scanned: 1,
        confirmed: 0,
        forceClosed: 1,
      });
      expect(confirmed).toEqual(['cmd-1']);
      expect(errors[0].context).toMatchObject({ ledger_end_reason: endReason });
    }
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

  // Past the proxy's delivery-claim TTL the claim that would absorb a
  // duplicate POST has expired anyway, so "we still cannot tell" stops being
  // a state worth preserving. A ceiling below the TTL would force-close a row
  // whose duplicate the proxy could still absorb.
  test('the force-close ceiling is never shorter than the proxy dedupe TTL', () => {
    expect(INBOX_FORWARD_CONFIRM_MAX_MS).toBeGreaterThanOrEqual(DEDUPE_TTL_MS);
  });
});
