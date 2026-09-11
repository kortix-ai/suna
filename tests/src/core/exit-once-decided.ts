import { log } from './log';

/**
 * Leave once the verdict is in, even if something forgot to close.
 *
 * By the time `main()` resolves the run is decided and the HTML report is
 * written. Setting `process.exitCode` alone means the process lives until the
 * event loop drains, so ONE leaked handle keeps a finished run alive forever.
 *
 * Release gate run 34510198802, api shard 4: printed
 * `results: 82/84 passed · 1 failed · 1 skipped · 0 todo · 1174.7s` at
 * 18:44:39, then sat idle for 40 minutes and was killed by the job's
 * 60-minute cap at 19:24:50. The suite's real verdict — one failed flow —
 * was replaced by `cancelled`, which poisoned `needs.api.result` and failed
 * `full suite + quality gates` for the whole promote. Shard 5 exited 16
 * seconds after its last flow; the difference was RUN-7, whose
 * `POST /sessions/:id/start?wait_ms=8000` timed out and left a handle behind.
 *
 * So: give the loop a short grace period to drain on its own — the normal
 * case, and the one where a straggling write still lands — then exit anyway.
 * Always say so. A forced exit is evidence of a leak, and this line is how
 * the next person finds it; swallowing it would trade a visible 40-minute
 * hang for an invisible bug.
 *
 * The timer is unref'd, so it never keeps an otherwise-idle process alive. It
 * still fires if something else is holding the loop open, which is precisely
 * the case worth catching.
 */
export function exitOnceDecided(
  code: number,
  deps: {
    warn?: (message: string) => void;
    exit?: (code: number) => void;
    setExitCode?: (code: number) => void;
  } = {},
): void {
  const warn = deps.warn ?? ((message: string) => log.warn(message));
  const exit = deps.exit ?? ((value: number) => process.exit(value));
  (deps.setExitCode ?? ((value: number) => { process.exitCode = value; }))(code);
  const graceMs = Number(process.env.KE2E_EXIT_GRACE_MS ?? 15_000);
  if (!Number.isFinite(graceMs) || graceMs <= 0) return;
  const forced = setTimeout(() => {
    warn(
      `the run finished with exit code ${code} but the process was still alive ` +
        `${(graceMs / 1000).toFixed(0)}s later — something left a handle open ` +
        `(an unclosed stream, socket, or pool). Exiting anyway; the verdict above stands. ` +
        `Set KE2E_EXIT_GRACE_MS=0 to wait indefinitely and debug it.`,
    );
    exit(code);
  }, graceMs);
  forced.unref?.();
}

