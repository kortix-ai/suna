import { kortixFromAuth } from '../api/sdk.ts';
import {
  emitJson,
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

Exit codes:
  0    settled — the agent is idle (work finished)
  3    blocked — a pending permission/question needs an answer
  124  timeout — still working when --timeout elapsed

Options:
  --timeout <seconds>   Give up after this long (default 300).
  --project <id>        Operate on this project id (default: linked).
  --host <name>         Operate against a non-default Kortix host.
  --json                Print {settled, blocked, waited_ms} as JSON.
  -h, --help            Show this help.
`;

const POLL_INTERVAL_MS = 2_000;
/** Consecutive idle polls required before declaring settled — one idle read
 *  right after a prompt_async can race the agent loop actually starting. */
const SETTLE_POLLS = 2;

export type WaitPollState = 'idle' | 'working' | 'blocked';

/**
 * Classify one poll. `statuses` is OpenCode's session-status map — an ABSENT
 * entry means idle (the server omits idle sessions). Pending interactive asks
 * win over everything: a blocked agent never becomes idle on its own.
 */
export function classifyWaitPoll(
  statuses: Record<string, { type?: string; [key: string]: unknown } | undefined>,
  opencodeSessionId: string,
  pending: { permissions: number; questions: number },
): WaitPollState {
  if (pending.permissions > 0 || pending.questions > 0) return 'blocked';
  const current = statuses[opencodeSessionId];
  if (!current || current.type === 'idle') return 'idle';
  return 'working';
}

export function isAuthoritativelySettled(status: string): boolean {
  return status === 'completed';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const sessionId = rest.find((a) => !a.startsWith('-'));
  if (!sessionId) {
    process.stdout.write(HELP);
    return 2;
  }
  const timeoutMs = Math.max(1, Number(timeoutRaw ?? 300)) * 1000;
  if (!Number.isFinite(timeoutMs)) {
    process.stderr.write(`${status.err(`--timeout expects seconds, got "${timeoutRaw}"`)}\n`);
    return 2;
  }

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
        const [statuses, permissions, questions] = await Promise.all([
          handle.runtime.session.status().then((r) => r.data ?? {}),
          handle.runtime.permission
            .list()
            .then((r) => (r.data ?? []) as Array<{ sessionID?: string }>)
            .catch(() => []),
          handle.runtime.question
            .list()
            .then((r) => (r.data ?? []) as Array<{ sessionID?: string }>)
            .catch(() => []),
        ]);
        state = classifyWaitPoll(
          statuses as Record<string, { type?: string }>,
          ready.opencodeSessionId,
          {
            permissions: permissions.filter((p) => p.sessionID === ready.opencodeSessionId).length,
            questions: questions.filter((q) => q.sessionID === ready.opencodeSessionId).length,
          },
        );
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
          const waited = Date.now() - startedAt;
          if (json) emitJson({ settled: true, blocked: false, waited_ms: waited });
          else
            process.stdout.write(
              `${status.ok(`Agent settled after ${Math.round(waited / 1000)}s.`)}\n`,
            );
          return 0;
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
