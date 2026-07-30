import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

// A SOURCE-LEVEL guard, because the defect it prevents is invisible to any unit
// test of the classifier itself.
//
// `isSandboxAuthored(apiKeyType, sessionId)` decides whether a request may extend
// a sandbox's life. It reads ANY non-null session id as "the box authored this".
// But `c.get('sessionId')` is overloaded — under `supabaseAuth` (and under
// `combinedAuth`'s JWT network-fallback branch) it is the SUPABASE AUTH SESSION
// id, i.e. which browser login this is. Handing that value to this function makes
// every logged-in human look like the sandbox, which silently disables:
//
//   * the turn-start observation on the ACP prompt route — the ONLY extension an
//     ACP session's box gets, since that route does not go through the proxy;
//   * the at-cap refusal, so the box is handed work the reaper kills mid-turn;
//   * the preview-use extension and `shouldAutoResumeStoppedSandbox` on the
//     path-based proxy edge.
//
// The repo already has the guard for this exact collision —
// `projects/lib/caller-session.ts` `callerKortixSessionId`, whose docstring lists
// three prior outages of the same shape. This test is what stops the next call
// site from reaching for the obvious context var instead.

const API_SRC = join(import.meta.dir, '..');

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      yield full;
    }
  }
}

// `isSandboxAuthored(<anything>, c.get('sessionId'))`, tolerant of whitespace and
// line breaks between the arguments. `[^;]` rather than `[^)]` on purpose: the
// FIRST argument is itself a `c.get(...)` call, so a `)`-excluding class stops
// before ever reaching the second one — which is exactly how the original defect
// would have slipped past this guard.
const RAW_CONTEXT_SESSION = /isSandboxAuthored\s*\([^;]{0,200}?c\.get\(\s*['"]sessionId['"]\s*\)/s;

describe('every isSandboxAuthored call site resolves the session id safely', () => {
  test('no production file passes the raw sessionId context var', async () => {
    const offenders: string[] = [];
    for await (const file of walk(API_SRC)) {
      const source = await Bun.file(file).text();
      if (!source.includes('isSandboxAuthored')) continue;
      if (RAW_CONTEXT_SESSION.test(source)) offenders.push(relative(API_SRC, file));
    }

    expect(offenders).toEqual([]);
  });

  // The guard above is only meaningful if the call sites it polices still exist.
  test('the call sites it polices are still there', async () => {
    const callers: string[] = [];
    for await (const file of walk(API_SRC)) {
      const source = await Bun.file(file).text();
      if (/isSandboxAuthored\s*\(/.test(source)) callers.push(relative(API_SRC, file));
    }

    expect(callers.sort()).toEqual([
      'projects/routes/acp.ts',
      // definition + the re-export barrel, not decisions
      'projects/sandbox-deadline-policy.ts',
      'projects/sandbox-deadline.ts',
      'sandbox-proxy/routes/preview.ts',
    ]);
  });
});

// Two of the four observations are single fire-and-forget lines whose BEHAVIOUR is
// unit-tested but whose WIRING was not: both could be deleted outright and the
// whole 4,800-test suite stayed green. Deleting either silently removes a grant
// nothing else provides — the warm-pool grant IS the only life a warm box gets,
// and the turn-end shorten is the only thing that ever pulls a deadline IN.
describe('the fire-and-forget deadline wirings are actually wired', () => {
  for (const [file, call] of [
    ['platform/services/session-sandbox.ts', 'grantWarmPoolLifetime('],
    ['projects/routes/r4.ts', 'shortenSandboxDeadlineOnTurnEnd('],
  ] as const) {
    test(`${file} still calls ${call})`, async () => {
      const source = await Bun.file(join(API_SRC, file)).text();
      // Not the import line: an unused import type-checks clean under
      // `noUnusedLocals: false` and would let the wiring vanish unnoticed.
      const callSites = source
        .split('\n')
        .filter((line) => line.includes(call) && !line.trimStart().startsWith('import'));

      expect(callSites.length).toBeGreaterThan(0);
    });
  }
});
