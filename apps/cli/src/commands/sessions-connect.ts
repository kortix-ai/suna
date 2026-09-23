import {
  attachOpenCodeSession,
  AttachOpenCodeError,
  attachSessionLabel,
} from '../attach-opencode.ts';
import { locateSessionAnywhere, surfaceApiError, takeFlagValue } from '../command-helpers.ts';
import { SessionRuntimeError } from '../session-runtime.ts';
import { C, help, status } from '../style.ts';
import { pickConnectSessionId } from './home.ts';
import { resolveRunningSessionId } from './sessions-chat.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const CONNECT_HELP = help`Usage: kortix sessions connect [<session-id>] [options] [-- <opencode attach args…>]

Attach your local OpenCode TUI to the OpenCode server already running inside a
Kortix session sandbox. The CLI opens a local loopback proxy, injects your
Kortix auth token, then runs \`opencode attach\` against it.

With no session id on an interactive terminal, opens a picker: running
sessions attach immediately, stopped ones are restarted and awaited, and
"+ New session" provisions a fresh sandbox first.

The \`opencode\` binary is managed for you: the CLI downloads the exact version
the session's server runs (cached under ~/.kortix/opencode/<version>/) so the
TUI and server never skew. Set KORTIX_OPENCODE_BIN to force your own binary.

Given a session id, resolves the right host/project on its own: tries the
active/linked project first, then — unless you pin --host/--project — scans
every logged-in host and account for the id. One command, no manual
\`kortix projects use\` / \`kortix hosts use\` first.

  --port <N>       Local loopback proxy port (default: random free port).
  --project <id>   Pin this project id (skips the cross-host scan).
  --host <name>    Pin this Kortix host (skips the cross-host scan).
  -h, --help       Show this help.

Examples:
  kortix sessions connect <session-id>
  kortix sessions connect <session-id> -- --mini
  kortix sessions connect --port 4100 <session-id>`;

export async function runSessionsConnect(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${CONNECT_HELP}\n`);
    return 0;
  }

  const separator = rest.indexOf('--');
  const attachArgs = separator >= 0 ? rest.splice(separator + 1) : [];
  if (separator >= 0) rest.splice(separator);

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let portRaw: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    portRaw = takeFlagValue(rest, ['--port']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    process.stderr.write(`${status.err('Pass at most one session id.')}\n`);
    return 2;
  }
  const proxyPort = parseConnectPort(portRaw);
  if (proxyPort === null) return 2;

  const opts: CtxOpts = { projectArg, hostArg };
  // No id + a real terminal → the full picker (running, dormant-with-restart,
  // or a fresh session). Non-TTY keeps the deterministic most-recent-running
  // resolution so agents / pipes / CI never block on a prompt.
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const sessionId = positional[0]
    ? positional[0]
    : tty
      ? await pickConnectSessionId(opts)
      : await resolveRunningSessionId(undefined, opts, 'Pick a session to connect to');
  if (!sessionId) return 1;

  // A session id may belong to a different project (or host) than the one
  // currently active/linked — locateSessionAnywhere finds it on its own
  // (--project/--host still pin it) instead of surfacing a bare "Not found".
  const found = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions connect ${sessionId} --host ${host}`,
  );
  if (!found) return 1;
  const { auth, projectId, projectName, hostName, session } = found.located;
  if (found.switched) {
    process.stderr.write(
      `${status.ok(`Found in ${C.bold}${projectName ?? projectId}${C.reset}`)} ` +
        `${C.dim}(host ${hostName}) — using it.${C.reset}\n`,
    );
  }

  // Everything from here on is `attachOpenCodeSession` — the same flow the
  // TUI runs. This command owns only the printing.
  try {
    const result = await attachOpenCodeSession({
      auth,
      projectId,
      sessionId: session.session_id,
      session,
      extraArgs: attachArgs,
      proxyPort,
      // The picker already restarts a dormant session; a bare stopped id keeps
      // its "run `kortix sessions restart` first" error.
      restartDormant: false,
      onStatus: (stage, _detail, context) => {
        if (stage !== 'attached' || !context.session) return;
        process.stderr.write(
          `${status.ok(`Connecting to ${C.bold}${attachSessionLabel(context.session)}${C.reset}`)} ` +
            `${C.dim}(OpenCode ${context.opencodeSessionId}, local ${context.proxyUrl})${C.reset}\n`,
        );
      },
    });
    return result.exitCode;
  } catch (err) {
    return reportAttachFailure(err, session.session_id);
  }
}

/** Reproduce the message each failure printed before the flow moved into the library. */
function reportAttachFailure(err: unknown, sessionId: string): number {
  if (!(err instanceof AttachOpenCodeError)) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
  if (err.cause instanceof SessionRuntimeError) {
    const failure = err.cause;
    if (failure.kind === 'not-running') {
      process.stderr.write(
        `${status.err(failure.message)}\n` +
          `  ${C.dim}Run \`kortix sessions restart ${sessionId}\` first.${C.reset}\n`,
      );
      return 1;
    }
    if (failure.kind === 'api' || failure.kind === 'ensure-ready') {
      return surfaceApiError(failure.cause);
    }
  }
  process.stderr.write(`${status.err(err.message)}\n`);
  if (err.stage === 'attached') {
    process.stderr.write(`  ${C.dim}Install OpenCode or set KORTIX_OPENCODE_BIN.${C.reset}\n`);
  }
  return 1;
}

function parseConnectPort(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`${status.err('--port must be 0-65535.')}\n`);
    return null;
  }
  return port;
}
