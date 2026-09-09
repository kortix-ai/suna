// THE ENV REPAIR IS NOT THE PROMPT'S TO PAY FOR.
//
// `repairCellSessionEnv` exists because a resumed cell comes back with no
// KORTIX_* env. It is best-effort by construction: it swallows every error,
// logs, and returns void. Nothing on the turn being delivered reads what it
// writes — a cell that has lost its env is repaired for the NEXT prompt either
// way, because the delivery has already gone out by the time a wiped cell could
// answer differently.
//
// Awaiting it therefore bought the prompt nothing and cost it a round trip.
// Measured on dev 2026-09-09 in named parts, steady-state prompts:
//
//   [cell-env] total=74ms {"is-cell":0,"session-key":1,"build-env":0,"post":73}
//   [cell-env] total=68ms {"is-cell":0,"session-key":2,"build-env":0,"post":66}
//   [cell-env] total=64ms {"is-cell":0,"session-key":1,"build-env":0,"post":63}
//
// This reads the source rather than mocking the module graph: the two call
// sites in the prompt path must not be awaited, and the guarantee that makes
// that safe — the function never rejecting — must still hold.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./sandbox-env-sync.ts', import.meta.url), 'utf8');

describe('the cell env repair on the prompt path', () => {
  test('is never awaited — a round trip to the box is not the turn\'s to pay', () => {
    expect(SRC).not.toMatch(/await\s+repairCellSessionEnv\s*\(/);
  });

  test('is still called, on both branches of the sync', () => {
    const calls = SRC.match(/void\s+repairCellSessionEnv\s*\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  test('every unawaited call carries a catch, so a rejection cannot become unhandled', () => {
    // `void f()` without `.catch()` is how a background call takes the process
    // down instead of logging. The function swallows its own errors today; the
    // catch is what keeps that from being a load-bearing implementation detail.
    const unawaited = SRC.split(/void\s+repairCellSessionEnv\s*\(/).slice(1);
    expect(unawaited.length).toBe(2);
    for (const tail of unawaited) {
      // The two call sites sit at different indents, so match on the chain
      // rather than on a fixed closing shape: whatever follows the argument
      // object, `.catch(` has to be in it before the statement ends.
      const statement = tail.slice(0, tail.indexOf(';') + 1);
      expect(statement).toContain('.catch(');
    }
  });

  test('the repair still cannot reject on its own — the catch is a belt, not the trousers', () => {
    // Its body is one try/catch that logs; if that ever stops being true the
    // claim above is the only thing standing between a wiped cell and a crash.
    const body = SRC.slice(SRC.indexOf('export async function repairCellSessionEnv'));
    const end = body.indexOf('\n}\n');
    expect(body.slice(0, end)).toContain('} catch (err) {');
  });

  test('it reports its parts, because the total was a mystery for a whole tick', () => {
    expect(SRC).toContain("[cell-env] timing");
    for (const part of ['is-cell', 'session-key', 'build-env', 'post']) {
      expect(SRC).toContain(`mark('${part}')`);
    }
  });
});
