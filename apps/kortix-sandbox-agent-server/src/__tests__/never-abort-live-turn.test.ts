/**
 * A turn that is still being written must never be aborted.
 *
 * The daemon closes turns that a dying opencode left unfinished, so a client
 * streaming one stops spinning. It decided "unfinished" as
 * `role === 'assistant' && !time.completed` — which is equally true of a turn
 * that is STREAMING RIGHT NOW.
 *
 * Aborting that one ends a healthy answer and stamps it with an AbortError,
 * which the web renders as "Interrupted" (session-error-banner.tsx) underneath
 * a reply that finished perfectly well. Reported from dev: a first "hey" got a
 * complete greeting, labelled Interrupted.
 *
 * The two cases separate by WAITING. Nothing is writing an orphaned turn, so it
 * stays unfinished forever; a live one completes in moments. So: look twice.
 *
 * Asserted on source — the real path needs a live opencode, its message API and
 * a genuine race. What regresses is the ORDER and the CONDITION, both visible.
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('../main.ts', import.meta.url).pathname).text();

function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

function fn(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return code(SRC.slice(start, SRC.indexOf('\n}\n', start)));
}

describe('confirmTurnOrphaned', () => {
  const body = fn('confirmTurnOrphaned');

  test('waits before deciding', () => {
    // The wait IS the discriminator. Without it there is nothing to distinguish
    // "nobody is writing this" from "not written YET".
    expect(body).toContain('ORPHAN_SETTLE_MS');
    expect(body).toMatch(/setTimeout/);
  });

  test('re-reads the turn rather than trusting the first look', () => {
    expect(body).toContain('await inspectRoot(');
  });

  test('refuses when the turn finished during the wait', () => {
    // The exact case that produced "Interrupted" on a complete answer.
    const guardAt = body.indexOf('if (!second.lastTurnIncomplete)');
    expect(guardAt).toBeGreaterThan(-1);
    // The refusal must come out of that branch, before the function can ever
    // reach its `return true`.
    const refuseAt = body.indexOf('return false', guardAt);
    expect(refuseAt).toBeGreaterThan(guardAt);
    expect(refuseAt).toBeLessThan(body.indexOf('return true'));
  });

  test('refuses when a DIFFERENT turn started meanwhile', () => {
    // Identity, not just state: a new turn is certainly alive, and aborting it
    // would interrupt work that started after we decided to clean up.
    expect(body).toContain('second.lastMessageId !== first.lastMessageId');
  });

  test('only returns true for a turn that is still unfinished AND unchanged', () => {
    const returns = body.split('\n').filter((l) => l.includes('return '));
    expect(returns.filter((l) => l.includes('true'))).toHaveLength(1);
    expect(returns.filter((l) => l.includes('false')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('every abort site goes through the guard', () => {
  test('finalizeOrphanedTurn confirms before aborting', () => {
    const body = fn('finalizeOrphanedTurn');
    const confirmAt = body.indexOf('confirmTurnOrphaned(');
    const abortAt = body.indexOf('abortOpencodeTurn(');
    expect(confirmAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(confirmAt);
  });

  test('the reused-root boot path confirms too', () => {
    // Two independent call sites reached the same abort. Fixing only the
    // respawn one would leave a session re-adopting a warm root still able to
    // kill a live turn.
    const src = code(SRC);
    const reuse = src.slice(src.indexOf('existing.lastTurnIncomplete'));
    expect(reuse.slice(0, 220)).toContain('confirmTurnOrphaned(');
  });

  test('no abort call bypasses the guard', () => {
    const src = code(SRC);
    // Every abortOpencodeTurn call except the definition must be preceded by a
    // confirm in the same function. Counted rather than parsed: two call sites,
    // two confirms.
    const aborts = [...src.matchAll(/await abortOpencodeTurn\(/g)].length;
    const confirms = [...src.matchAll(/confirmTurnOrphaned\(/g)].length;
    // one definition + two uses
    expect(confirms).toBe(aborts + 1);
  });
});

describe('inspectRoot carries turn identity', () => {
  test('reports the last message id', () => {
    // Without it the re-check cannot tell a new turn from the old one.
    const body = fn('inspectRoot');
    expect(body).toContain('lastMessageId');
    expect(body).toContain('last?.info?.id');
  });

  test('every early return still supplies the field', () => {
    // A missing id silently disables the "different turn" half of the guard.
    const body = fn('inspectRoot');
    // Split on the returns themselves — several are multi-line, so a per-line
    // scan would miss the field sitting two lines below `return {`.
    const blocks = body.split('return {').slice(1);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.slice(0, 220)).toContain('lastMessageId');
  });
});
