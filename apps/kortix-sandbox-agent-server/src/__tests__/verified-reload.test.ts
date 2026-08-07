/**
 * A reload must never leave the session without an opencode.
 *
 * The old path was `stop()` then `start()` — kill the only opencode, then hope
 * the replacement boots. When it did not (a config the build rejects, a bad
 * agent file, a failed dependency install) the session was left with nothing,
 * and the reload had destroyed the thing it was meant to update.
 *
 * The required shape is: boot the candidate, verify it serves, then promote it
 * and retire the old process.
 *
 * These assert on source structure. The supervisor owns real child processes,
 * real ports and a real readiness probe; spawning opencode in unit tests would
 * be slow and flaky. What regresses here is the ORDERING and the FAILURE
 * BRANCH — kill-before-verify, or treating a failed boot as success — and both
 * are visible in the source. The live swap is exercised on dev.
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('../opencode.ts', import.meta.url).pathname).text();
const CONFIG = await Bun.file(new URL('../config.ts', import.meta.url).pathname).text();
const PROXY = await Bun.file(new URL('../proxy.ts', import.meta.url).pathname).text();
const REFRESH = await Bun.file(new URL('../routes/refresh.ts', import.meta.url).pathname).text();

/** `verifyCandidateBoots`'s body, comments stripped. */
function candidateBody(): string {
  const start = SRC.indexOf('async function verifyCandidateBoots(');
  expect(start).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  const end = rest.indexOf('\n  /**\n   * Poll the real session API');
  const body = end > 0 ? rest.slice(0, end) : rest;
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('the candidate boots before anything is killed', () => {
  const body = candidateBody();

  test('spawns the candidate on the standby port, unsupervised', () => {
    expect(body).toContain('opencodeStandbyPort');
    expect(body).toContain('supervise: false');
  });

  test('the verdict comes from a real boot, not an assumption', () => {
    const probeAt = body.indexOf('probeUntilReady');
    const spawnAt = body.indexOf('spawnChild(binaryPath');
    expect(spawnAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(spawnAt);
  });

  test('does not touch the running opencode before the verdict', () => {
    expect(body).not.toContain('this.restart()');
    expect(body).not.toContain("stop('SIGTERM')");
    expect(body).not.toContain('child = candidate');
  });

  test('returns the live candidate after a successful probe', () => {
    expect(body).toContain('return { ok: true, candidate, port: candidatePort }');
  });
});

describe('when the candidate never comes up', () => {
  const body = candidateBody();

  test('says why, so the caller can report a failed reload', () => {
    expect(body).toMatch(/reason:/);
    const method = SRC.slice(SRC.indexOf('async reloadVerified('));
    expect(method).toContain("outcome: 'kept-old'");
    expect(method).toContain('proven.reason');
  });

  test('reports ok:false rather than throwing', () => {
    expect(body).toContain('return { ok: false');
  });

  test('retires only the failed candidate', () => {
    const failureAt = body.indexOf('if (!ready)');
    const retireAt = body.indexOf("await killProcessGroup(candidate, 'SIGTERM')", failureAt);
    const returnAt = body.indexOf("return { ok: false, reason: 'the new opencode", failureAt);
    expect(retireAt).toBeGreaterThan(failureAt);
    expect(retireAt).toBeLessThan(returnAt);
  });
});

describe('readiness means the session API answers', () => {
  test('probes the real session API, not a port check', () => {
    // opencode binds its port seconds before the project directory is usable.
    // A TCP or plain-health check would call a half-open process ready and we
    // would swap onto something that cannot answer a prompt.
    const probe = SRC.slice(SRC.indexOf('async function probeUntilReady'));
    expect(probe).toContain('probeOpencodeSessionApi');
  });

  test('gives up early if the candidate dies', () => {
    const probe = SRC.slice(SRC.indexOf('async function probeUntilReady'));
    expect(probe).toContain('proc.exitCode !== null');
  });

  test('a stale probe cannot downgrade a newly promoted process', () => {
    const probe = SRC.slice(
      SRC.indexOf('function scheduleReadinessProbe()'),
      SRC.indexOf('\n  return {', SRC.indexOf('function scheduleReadinessProbe()')),
    );
    expect(probe).toContain('const probedPort = activePort');
    expect(probe).toContain('if (probedPort !== activePort)');
  });
});

describe('the port pair', () => {
  test('both halves are fixed config, not allocated at reload time', () => {
    expect(CONFIG).toContain('KORTIX_OPENCODE_STANDBY_PORT');
    expect(CONFIG).toContain('opencodeStandbyPort');
  });

  test('both halves are blocked in the web proxy self-port set', () => {
    // The reason the pair is fixed. This set is built once at startup, so an
    // ephemeral candidate port would be unguarded the moment it went live —
    // an unproxied route from the sandbox to its own opencode.
    const call = PROXY.slice(PROXY.indexOf('blockedSelfPorts'), PROXY.indexOf('blockedSelfPorts') + 260);
    expect(call).toContain('cfg.opencodeInternalPort');
    expect(call).toContain('cfg.opencodeStandbyPort');
  });

  test('chooses the idle half relative to the current active port', () => {
    const body = candidateBody();
    expect(body).toContain('activePort === currentCfg.opencodeInternalPort');
    expect(body).toContain('currentCfg.opencodeStandbyPort');
  });
});

describe('reloadVerified promotes the verified process', () => {
  /** The method body, comments stripped. */
  function methodBody(): string {
    const start = SRC.indexOf('async reloadVerified(');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('\n    },', start));
    return body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  }

  test('verifies before changing the active process', () => {
    const body = methodBody();
    const verifyAt = body.indexOf('verifyCandidateBoots(');
    const promoteAt = body.indexOf('child = proven.candidate');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(promoteAt).toBeGreaterThan(verifyAt);
  });

  test('returns kept-old without promotion when verification fails', () => {
    const body = methodBody();
    const guardAt = body.indexOf('if (!proven.ok) return');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(body.indexOf('child = proven.candidate'));
  });

  test('does not boot a second replacement after verification', () => {
    expect(methodBody()).not.toContain('this.restart()');
  });

  test('switches routing before retiring the previous process', () => {
    const body = methodBody();
    const routeAt = body.indexOf('activePort = proven.port');
    const childAt = body.indexOf('child = proven.candidate');
    const retireAt = body.indexOf("killProcessGroup(previous, 'SIGTERM')");
    expect(routeAt).toBeGreaterThan(-1);
    expect(childAt).toBeGreaterThan(routeAt);
    expect(retireAt).toBeGreaterThan(childAt);
  });

  test('supervises the promoted process', () => {
    const body = methodBody();
    expect(body).toContain('superviseChild(proven.candidate)');
  });
});

describe('callers get the outcome', () => {
  test('reloadConfig verifies before it restarts', () => {
    const reload = SRC.split('async reloadConfig(')[1]?.split('\n    },')[0] ?? '';
    const code = reload
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).toContain('this.reloadVerified(');
  });

  test('reloadConfig reports kept-old rather than claiming success', () => {
    const reload = SRC.split('async reloadConfig(')[1]?.split('\n    },')[0] ?? '';
    expect(reload).toContain("return 'kept-old'");
  });

  test('the refresh route returns the outcome so CLI and web can show it', () => {
    expect(REFRESH).toContain('opencode.reloadVerified(');
    expect(REFRESH).toContain('outcome: reload.outcome');
    // The reason has to reach the user — "reload failed" with no cause is the
    // whole complaint about the old behaviour.
    expect(REFRESH).toContain('reason: reload.reason');
  });

  test('a declined swap does not fail the repo work', () => {
    // The pull succeeded; only the reload declined. Reporting ok:false would
    // hide a good pull behind a safety mechanism doing its job.
    expect(REFRESH).toContain('ok: true');
  });
});

/**
 * The fault-injection switch that makes the decline path provable on a real box.
 *
 * It exists because nothing else can reach that branch in production: the API
 * validates agent configs against opencode's schema before they ever arrive at
 * a sandbox, so no supported input produces a config that fails to boot. The
 * branch is the whole safety mechanism, and "covered by unit tests only" is a
 * weak place to leave it.
 */
describe('verify_fail fault injection', () => {
  test('forces the verdict AFTER a real spawn, not instead of one', () => {
    // A shortcut that returned early would prove the plumbing and nothing else.
    // Spawning for real means the injected run exercises the same code as a
    // genuine failure: candidate started, candidate retired, incumbent alive.
    const body = candidateBody();
    const spawnAt = body.indexOf('spawnChild(binaryPath');
    const forceAt = body.indexOf('opts.forceFail');
    expect(spawnAt).toBeGreaterThan(-1);
    expect(forceAt).toBeGreaterThan(spawnAt);
  });

  test('still retires the candidate when injected', () => {
    const body = candidateBody();
    expect(body.indexOf('killProcessGroup(candidate')).toBeGreaterThan(
      body.indexOf('opts.forceFail'),
    );
  });

  test('the route only injects on an explicit opt-in', () => {
    // Default MUST be a normal reload. A flag that defaulted on would turn
    // every reload on the box into a no-op.
    expect(REFRESH).toContain("c.req.query('verify_fail') === '1'");
  });

  test('injection cannot reach promotion', () => {
    const method = SRC.slice(SRC.indexOf('async reloadVerified('));
    const guardAt = method.indexOf('if (!proven.ok) return');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(method.indexOf('child = proven.candidate'));
  });
});
