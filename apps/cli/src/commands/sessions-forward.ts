import {
  fail,
  locateSessionAnywhere,
  missing,
  surfaceApiError,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { type ForwardRequest, PortForwardError, startPortForward } from '../port-forward.ts';
import { SessionRuntimeError } from '../session-runtime.ts';
import { C, help, status } from '../style.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const FORWARD_HELP = help`Usage: kortix sessions forward <session-id> --port <sandbox>[:<local>] [options]

Forward one or more sandbox ports to your own machine, VS Code-style — so a
dev server an agent started inside a session sandbox (e.g. \`http://localhost:3000\`
printed in its output) is reachable at that same address in your own browser.

Each \`--port\` is repeatable and takes \`<sandbox-port>\` or
\`<sandbox-port>:<local-port>\`. With no local port, the same port number is
used if it's free on your machine, else the next free one. \`--port N:0\`
requests an OS-assigned ephemeral local port.

Both HTTP and WebSocket traffic are forwarded (dev-server hot reload works).
Prints one line per forward, then stays in the foreground until Ctrl+C closes
every listener.

The session's sandbox must already be running — this command does not start
one. A stopped session's remedy is printed for you: run
\`kortix sessions restart <session-id>\` first.

  --port <sandbox>[:<local>]  Forward a sandbox port (repeatable, required).
  --project <id>              Pin this project id (skips the cross-host scan).
  --host <name>                Pin this Kortix host (skips the cross-host scan).
  -h, --help                  Show this help.

Examples:
  kortix sessions forward <session-id> --port 3000
  kortix sessions forward <session-id> --port 3000:4000
  kortix sessions forward <session-id> --port 3000 --port 5173:0`;

export async function runSessionsForward(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${FORWARD_HELP}\n`);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let portArgs: string[];
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    portArgs = takeFlagValues(rest, ['--port']);
  } catch (err) {
    return fail((err as Error).message);
  }

  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length === 0) return missing('a session id');
  if (positional.length > 1) return fail('Pass at most one session id.');
  if (portArgs.length === 0) return missing('at least one --port <sandbox>[:<local>]');

  let forwards: ForwardRequest[];
  try {
    forwards = portArgs.map(parsePortArg);
  } catch (err) {
    return fail((err as Error).message);
  }

  const sessionId = positional[0];
  const found = await locateSessionAnywhere(
    sessionId,
    { projectArg, hostArg },
    (host) =>
      `kortix sessions forward ${sessionId} --host ${host} ${portArgs.map((p) => `--port ${p}`).join(' ')}`,
  );
  if (!found) return 1;
  const { auth, projectId, projectName, hostName, session } = found.located;
  if (found.switched) {
    process.stderr.write(
      `${status.ok(`Found in ${C.bold}${projectName ?? projectId}${C.reset}`)} ` +
        `${C.dim}(host ${hostName}) — using it.${C.reset}\n`,
    );
  }

  let result: Awaited<ReturnType<typeof startPortForward>>;
  try {
    result = await startPortForward({
      auth,
      projectId,
      sessionId: session.session_id,
      session,
      forwards,
    });
  } catch (err) {
    return reportForwardFailure(err, session.session_id);
  }

  for (const forward of result.forwards) {
    process.stdout.write(`⇄ localhost:${forward.localPort} → sandbox:${forward.sandboxPort}\n`);
  }
  process.stderr.write(`${C.dim}Ctrl+C to stop forwarding.${C.reset}\n`);

  return new Promise<number>((resolve) => {
    const stop = () => {
      result.close();
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** Parse one `--port` value: `<sandbox>` or `<sandbox>:<local>`. */
function parsePortArg(raw: string): ForwardRequest {
  const match = raw.match(/^(\d{1,5})(?::(\d{1,5}))?$/);
  if (!match) {
    throw new Error(`--port expects <sandbox-port> or <sandbox-port>:<local-port>, got "${raw}"`);
  }
  const sandboxPort = Number(match[1]);
  if (sandboxPort < 1 || sandboxPort > 65535) {
    throw new Error(`--port sandbox port must be 1-65535, got "${match[1]}"`);
  }
  if (match[2] === undefined) return { sandboxPort };
  const localPort = Number(match[2]);
  if (localPort < 0 || localPort > 65535) {
    throw new Error(`--port local port must be 0-65535, got "${match[2]}"`);
  }
  return { sandboxPort, localPort };
}

function reportForwardFailure(err: unknown, sessionId: string): number {
  if (!(err instanceof PortForwardError)) {
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
  return 1;
}
