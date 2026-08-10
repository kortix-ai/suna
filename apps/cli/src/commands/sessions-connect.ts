import { spawn } from 'node:child_process';

import { type RunningOpenCodeProxy, startOpenCodeProxy } from '../api/sdk.ts';
import { takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';
import {
  ensureOpencodeSession,
  loadSessionForChat,
  resolveRunningSessionId,
} from './sessions-chat.ts';

type CtxOpts = { workspaceArg?: string; hostArg?: string };

const CONNECT_HELP = help`Usage: kortix sessions connect [<session-id>] [options] [-- <opencode attach args…>]

Attach your local OpenCode TUI to the OpenCode server already running inside a
Kortix session sandbox. The CLI opens a local loopback proxy, injects your
Kortix auth token, then runs \`opencode attach\` against it.

Given a session id, resolves the right host/workspace on its own: tries the
active/linked workspace first, then — unless you pin --host/--workspace — scans
every logged-in host and account for the id. One command, no manual
\`kortix workspaces use\` / \`kortix hosts use\` first.

  --port <N>       Local loopback proxy port (default: random free port).
  --workspace <id>   Pin this workspace id (skips the cross-host scan).
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

  let workspaceArg: string | undefined;
  let hostArg: string | undefined;
  let portRaw: string | undefined;
  try {
    workspaceArg = takeFlagValue(rest, ['--workspace', '--project']);
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

  const opts: CtxOpts = { workspaceArg, hostArg };
  const sessionId = await resolveRunningSessionId(
    positional[0],
    opts,
    'Pick a session to connect to',
  );
  if (!sessionId) return 1;

  // A session id may belong to a different workspace (or host) than the one
  // currently active/linked — loadSessionForChat locates it on its own
  // (--project/--host still pin it) instead of surfacing a bare "Not found".
  const resolved = await loadSessionForChat(sessionId, opts, 'sessions connect');
  if (!resolved) return 1;
  const ocSessionId = await ensureOpencodeSession(resolved);
  if (!ocSessionId) return 1;

  let proxy: RunningOpenCodeProxy;
  try {
    proxy = startOpenCodeProxy({
      runtimeUrl: resolved.runtimeUrl,
      token: resolved.auth.token,
      port: proxyPort,
    });
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }

  const label = resolved.session.name ?? resolved.session.session_id.split('-')[0];
  const attachCommand = buildAttachArgs(proxy.url, ocSessionId, attachArgs);
  process.stderr.write(
    `${status.ok(`Connecting to ${C.bold}${label}${C.reset}`)} ` +
      `${C.dim}(OpenCode ${ocSessionId}, local ${proxy.url})${C.reset}\n`,
  );

  try {
    return await spawnOpenCodeAttach(attachCommand);
  } finally {
    proxy.close();
  }
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

function buildAttachArgs(url: string, opencodeSessionId: string, extraArgs: string[]): string[] {
  const hasContinuation = extraArgs.some(
    (arg) =>
      arg === '--session' ||
      arg === '-s' ||
      arg.startsWith('--session=') ||
      arg === '--continue' ||
      arg === '-c',
  );
  return [
    'attach',
    url,
    ...(hasContinuation ? [] : ['--session', opencodeSessionId]),
    ...extraArgs,
  ];
}

function spawnOpenCodeAttach(args: string[]): Promise<number> {
  const bin = process.env.KORTIX_OPENCODE_BIN || 'opencode';
  const child = spawn(bin, args, { stdio: 'inherit' });
  return new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(
        `${status.err(`Could not run ${bin}: ${err.message}`)}\n` +
          `  ${C.dim}Install OpenCode or set KORTIX_OPENCODE_BIN.${C.reset}\n`,
      );
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') resolve(code);
      else resolve(signal ? 130 : 1);
    });
  });
}
