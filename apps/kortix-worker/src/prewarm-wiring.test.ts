/**
 * The prewarm has to be REACHABLE, not just correct.
 *
 * `prewarm.test.ts` proves `LazyKortixEnv.prewarm()` behaves — it is
 * idempotent, it does not block, a tool call joins an in-flight attach. All of
 * that was true and none of it mattered, because the call site was wrong:
 *
 *     buildHarness()  — declares `lazy`        (worker.ts:239-456)
 *     startWorker()   — calls `lazy.prewarm()` (worker.ts:463+)
 *
 * `lazy` is a `const` inside `buildHarness`, so the reference in `startWorker`
 * is simply not in scope. Every turn on pi.kortix.com answered
 *
 *     event: error
 *     data: {"error":"lazy is not defined"}
 *
 * from the moment that line shipped. The unit test could not see it: it
 * exercised the class, never the wiring. This one reads the wiring.
 */
import { describe, expect, test } from 'bun:test';

async function workerSource(): Promise<string> {
  return Bun.file(new URL('./worker.ts', import.meta.url)).text();
}

function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`not found: ${declaration}`);
  // Walk braces from the declaration to find where the function closes.
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; seen = true; }
    else if (source[i] === '}') {
      depth -= 1;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated: ${declaration}`);
}

describe('the prompt-time prewarm is wired to something that exists', () => {
  test('`lazy` is declared in buildHarness and RETURNED from it', async () => {
    const source = await workerSource();
    const build = functionBody(source, 'export async function buildHarness');
    expect(build).toContain('const lazy =');
    // Without this, every consumer outside buildHarness references a binding
    // that is not in scope — which is exactly what shipped.
    expect(build).toMatch(/return \{[^}]*\blazy\b/s);
  });

  test('startWorker destructures `lazy` before using it', async () => {
    const source = await workerSource();
    const start = functionBody(source, 'export async function startWorker');
    expect(start).toContain('lazy.prewarm()');
    const destructure = start.slice(0, start.indexOf('await buildHarness'));
    expect(destructure).toMatch(/\blazy\b/);
  });

  test('every `lazy` reference in startWorker is inside startWorker', async () => {
    // The general form of the bug: a binding used across a function boundary.
    const source = await workerSource();
    const build = functionBody(source, 'export async function buildHarness');
    const start = functionBody(source, 'export async function startWorker');
    // The two bodies must not overlap — if they did, this test proves nothing.
    expect(source.indexOf(start)).toBeGreaterThan(source.indexOf(build) + build.length - 1);
    // And startWorker must bind `lazy` itself rather than borrowing it.
    const bindsOwn = /\blazy\b/.test(start.slice(0, start.indexOf('buildHarness') + 20));
    expect(bindsOwn).toBe(true);
  });
});
