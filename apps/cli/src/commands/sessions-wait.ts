import { sleep } from '@kortix/shared/guards';
import { kortixFromAuth } from '../api/sdk.ts';
import {
  emitJson,
  fail,
  locateSessionAnywhere,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix sessions wait-for <session-id> [options]

Block until the session's agent finishes its current work (the agent loop
is idle), instead of polling with sleeps. Also returns early when the agent
is blocked on a tool-permission ask or a question, so a coordinator can
answer it (\`kortix sessions pending\`) instead of waiting out the timeout.
When the turn that ends while waiting failed, the command exits 1 and
prints the cause the control plane recorded. A failure that already
predates the wait by more than a minute is history the caller did not
wait for, and settles with 0.

Exit codes:
  0    settled — the agent is idle and the last turn completed
  1    settled, but the agent's last turn failed (the cause is printed)
  3    blocked — a pending permission/question needs an answer
  124  timeout — still working when --timeout elapsed

Options:
  --timeout <seconds>   Give up after this long (default 300).
  --project <id>        Operate on this project id (default: linked).
  --host <name>         Operate against a non-default Kortix host.
  --json                Print {settled, blocked, waited_ms, failed?, error?} as JSON.
  -h, --help            Show this help.
`;

const POLL_INTERVAL_MS = 2_000;
/** Consecutive idle polls required before declaring settled — one idle read
 *  right after a prompt_async can race the agent loop actually starting. */
const SETTLE_POLLS = 2;
/** How long before the wait attached a failure may have landed and still
 *  count as the turn the caller is waiting on: `sessions new --prompt --wait`
 *  returns once the runtime is ready, and the first turn can already have
 *  failed by the time `wait-for` starts polling. A failure older than this
 *  window is history the caller did not wait for, and settles with 0. */
const TURN_FAILURE_GRACE_MS = 60_000;

export type WaitPollState = 'idle' | 'working' | 'blocked';

/** The shape of the control plane's `/turn` read that the settle decision
 *  reads. Structural, so tests can build minimal fixtures. */
interface SettledTurnStatus {
  turns: unknown[];
  last_ended?: {
    end_reason: string | null;
    ended_at: string | null;
    error?: { message: string | null } | null;
  } | null;
}

type SettledTurnOutcome =
  | { state: 'working' }
  | { state: 'ok' }
  | { state: 'failed'; reason: string };

/** What a settled wait says about the turn that just ended, from the control
 *  plane's own `/turn` read — server truth, independent of the live stream.
 *
 *  `working` — a turn is running again (a queued prompt started between the
 *  last two polls), so the agent is not actually idle and the wait continues.
 *  `failed` — the most recent turn ended failed within the freshness window;
 *  the reason is the cause the ledger recorded, or a marker when nobody
 *  named one. `ok` — every other settle, exactly the pre-existing exit 0. */
export function settledTurnOutcome(turn: SettledTurnStatus, startedAt: number): SettledTurnOutcome {
  if (turn.turns.length > 0) return { state: 'working' };
  const lastEnded = turn.last_ended;
  if (!lastEnded || lastEnded.end_reason !== 'failed') return { state: 'ok' };
  // A missing timestamp cannot prove the failure predates the wait, and
  // reporting a real failure beats silencing one.
  const endedMs = lastEnded.ended_at ? Date.parse(lastEnded.ended_at) : Number.NaN;
  if (Number.isFinite(endedMs) && endedMs < startedAt - TURN_FAILURE_GRACE_MS) {
    return { state: 'ok' };
  }
  return { state: 'failed', reason: lastEnded.error?.message ?? 'No cause recorded' };
}

/**
 * Classify one poll. `statuses` is OpenCode's session-status map — an ABSENT
 * entry means idle (the server omits idle sessions). Pending interactive asks
 * win over everything: a blocked agent never becomes idle on its own.
 */
export function classifyWaitPoll(
  statuses: Record<string, { type?: string; [key: string]: unknown } | undefined>,
  runtimeSessionId: string,
  pending: { permissions: number; questions: number },
): WaitPollState {
  if (pending.permissions > 0 || pending.questions > 0) return 'blocked';
  const current = statuses[runtimeSessionId];
  if (!current || current.type === 'idle') return 'idle';
  return 'working';
}

export function isAuthoritativelySettled(status: string): boolean {
  return status === 'completed';
}

export async function runSessionsWaitFor(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.length === 0 || rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return rest.length === 0 ? 2 : 0;
  }
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let timeoutRaw: string | undefined;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    timeoutRaw = takeFlagValue(rest, ['--timeout', '-t']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const sessionId = rest.find((a) => !a.startsWith('-'));
  if (!sessionId) {
    process.stdout.write(HELP);
    return 2;
  }
  const timeoutMs = Math.max(1, Number(timeoutRaw ?? 300)) * 1000;
  if (!Number.isFinite(timeoutMs)) return fail(`--timeout expects seconds, got "${timeoutRaw}"`);

  const found = await locateSessionAnywhere(
    sessionId,
    { projectArg, hostArg },
    (host) => `kortix sessions wait-for ${sessionId} --host ${host}`,
  );
  if (!found) return 1;
  const resolved = {
    session: found.located.session,
    auth: found.located.auth,
    ctx: { projectId: found.located.projectId },
  };

  // `completed` is authoritative. A stopped session can be a manual or
  // interrupted stop, so ensureReady() must wake it and inspect the agent loop.
  if (isAuthoritativelySettled(resolved.session.status)) {
    if (json)
      emitJson({
        settled: true,
        blocked: false,
        waited_ms: 0,
        session_status: resolved.session.status,
      });
    else
      process.stdout.write(
        `${status.ok(`Session is ${resolved.session.status} — nothing running.`)}\n`,
      );
    return 0;
  }

  const handle = kortixFromAuth(resolved.auth).session(
    resolved.ctx.projectId,
    resolved.session.session_id,
  );
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let idleStreak = 0;

  try {
    const ready = await handle.ensureReady();
    while (Date.now() < deadline) {
      let state: WaitPollState | null = null;
      try {
        const { statuses, permissions, questions } = await handle.pending();
        state = classifyWaitPoll(statuses, ready.runtimeSessionId, {
          permissions: permissions.filter((p) => p.sessionID === ready.runtimeSessionId).length,
          questions: questions.filter((q) => q.sessionID === ready.runtimeSessionId).length,
        });
      } catch {
        // Transient proxy/runtime error — count as unknown, keep waiting.
        idleStreak = 0;
      }

      if (state === 'blocked') {
        const waited = Date.now() - startedAt;
        if (json) emitJson({ settled: false, blocked: true, waited_ms: waited });
        else {
          process.stdout.write(
            `${status.err('Agent is blocked on a pending ask.')}\n` +
              `  ${C.dim}Answer it: \`kortix sessions pending ${resolved.session.session_id}\`.${C.reset}\n`,
          );
        }
        return 3;
      }
      if (state === 'idle') {
        idleStreak += 1;
        if (idleStreak >= SETTLE_POLLS) {
          let outcome: SettledTurnOutcome = { state: 'ok' };
          try {
            outcome = settledTurnOutcome(await handle.turn(), startedAt);
          } catch {
            // The /turn read is evidence, not the wait condition: on a
            // transient failure settle exactly as before.
          }
          if (outcome.state === 'working') {
            idleStreak = 0;
          } else if (outcome.state === 'failed') {
            const waited = Date.now() - startedAt;
            if (json)
              emitJson({
                settled: true,
                blocked: false,
                waited_ms: waited,
                failed: true,
                error: outcome.reason,
              });
            else
              process.stdout.write(
                `${status.err(`Agent turn failed: ${outcome.reason}`)}\n` +
                  `  ${C.dim}Inspect: \`kortix sessions log ${resolved.session.session_id}\`.${C.reset}\n`,
              );
            return 1;
          } else {
            const waited = Date.now() - startedAt;
            if (json) emitJson({ settled: true, blocked: false, waited_ms: waited });
            else
              process.stdout.write(
                `${status.ok(`Agent settled after ${Math.round(waited / 1000)}s.`)}\n`,
              );
            return 0;
          }
        }
      } else if (state === 'working') {
        idleStreak = 0;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
  } catch (err) {
    return surfaceApiError(err);
  }

  const waited = Date.now() - startedAt;
  if (json) emitJson({ settled: false, blocked: false, waited_ms: waited, timeout: true });
  else {
    process.stdout.write(
      `${status.err(`Still working after ${Math.round(waited / 1000)}s — timed out.`)}\n` +
        `  ${C.dim}Peek: \`kortix sessions status\` · wait longer: \`--timeout ${Math.round((timeoutMs / 1000) * 2)}\`.${C.reset}\n`,
    );
  }
  return 124;
}
