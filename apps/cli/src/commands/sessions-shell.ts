import { kortixPtyWsUrl, type OpencodePty } from '../api/sandbox-proxy.ts';
import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';
import {
  loadOpenCodeSession,
  resolveRunningSessionId,
  type ResolvedOpenCodeSession,
} from './sessions-chat.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const PTY_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as const;

/**
 * Shell-integration hooks embed protocol noise in the byte stream (cursor
 * position pings as OSC 697 + a bare JSON payload) that no terminal
 * emulator is meant to render literally — the web app's xterm-based
 * terminal strips the same patterns before display. A real terminal isn't
 * shielded from this the way xterm.js is, so without stripping it here the
 * first prompt after connect would show visible garbage.
 */
function sanitizePtyChunk(chunk: string): string {
  return chunk
    .replace(/\x1b\]697;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x00?\{"cursor":\d+\}/g, '')
    .replace(/\x1b\][0-9]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\]4;[0-9]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[\??[0-9;]*\$y/g, '')
    .replace(/\x1b\[\d+;\d+R/g, '')
    .replace(/\x1b\[\?[0-9;]*c/g, '');
}

const SHELL_HELP = help`Usage: kortix sessions shell [<session-id>] [options]

Open a raw interactive terminal (PTY) inside a running session's sandbox —
the same shell you'd get from the "Terminal" panel in the dashboard. Unlike
\`sessions connect\` (which attaches to the OpenCode agent), this is a plain
shell: no agent, no chat, just a prompt.

Reattaches to the session's existing terminal if one is already running
(same one the dashboard shows) so you never lose your place; pass --new to
always start a fresh shell instead. Behaves like ssh — Ctrl+C/Ctrl+D go to
the remote shell, not this CLI; type \`exit\` or close the terminal to leave.

  --new            Start a brand-new shell instead of reattaching.
  --project <id>   Pin this project id (skips the cross-host scan).
  --host <name>    Pin this Kortix host (skips the cross-host scan).
  -h, --help       Show this help.

Examples:
  kortix sessions shell <session-id>
  kortix sessions shell <session-id> --new`;

export async function runSessionsShell(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${SHELL_HELP}\n`);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const wantNew = takeFlagBool(rest, ['--new']);

  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    process.stderr.write(`${status.err('Pass at most one session id.')}\n`);
    return 2;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${status.err('sessions shell requires an interactive terminal.')}\n`);
    return 1;
  }

  const opts: CtxOpts = { projectArg, hostArg };
  const sessionId = await resolveRunningSessionId(positional[0], opts, 'Pick a session to open a shell in');
  if (!sessionId) return 1;

  const resolved = await loadOpenCodeSession(sessionId, opts, 'sessions shell');
  if (!resolved) return 1;

  let pty: OpencodePty;
  try {
    pty = wantNew ? await createPty(resolved) : await ensurePty(resolved);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }

  const label = resolved.session.name ?? resolved.session.session_id.split('-')[0];
  process.stderr.write(
    `${status.ok(`Opening shell in ${C.bold}${label}${C.reset}`)} ${C.dim}(pty ${pty.id})${C.reset}\n`,
  );

  return runPtySession(resolved, pty);
}

/** Reuse the session's existing terminal if one's already running (matches
 *  the dashboard's "ambient shell" — one persistent terminal per session,
 *  never killed on disconnect), else spawn one. */
async function ensurePty(resolved: ResolvedOpenCodeSession): Promise<OpencodePty> {
  const existing = await resolved.oc.listPty();
  if (existing.length > 0) return existing[0]!;
  return createPty(resolved);
}

function createPty(resolved: ResolvedOpenCodeSession): Promise<OpencodePty> {
  return resolved.oc.createPty({ title: 'Session terminal', env: { ...PTY_ENV } });
}

/** Put the local terminal in raw mode, pipe bytes to/from the remote PTY's
 *  WebSocket, and forward local resizes. Returns once the connection ends. */
function runPtySession(resolved: ResolvedOpenCodeSession, pty: OpencodePty): Promise<number> {
  const wsUrl = kortixPtyWsUrl(resolved.auth, resolved.proxyId, pty.id);
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const sendResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resolved.oc
        .updatePty(pty.id, { size: { rows: process.stdout.rows, cols: process.stdout.columns } })
        .catch(() => {});
    }, 100);
  };

  const onStdinData = (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  };

  let rawModeOn = false;
  const cleanup = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    process.stdout.removeListener('resize', sendResize);
    process.stdin.removeListener('data', onStdinData);
    if (rawModeOn) {
      process.stdin.setRawMode(false);
      rawModeOn = false;
    }
    process.stdin.pause();
  };
  // Safety net: restore the terminal even if we exit some other way (crash,
  // uncaught rejection) — an app left in raw mode looks "broken" to the user.
  process.once('exit', cleanup);

  return new Promise<number>((resolve) => {
    let resolved_ = false;
    const finish = (code: number) => {
      if (resolved_) return;
      resolved_ = true;
      cleanup();
      resolve(code);
    };

    ws.onopen = () => {
      process.stdin.setRawMode(true);
      rawModeOn = true;
      process.stdin.resume();
      process.stdin.on('data', onStdinData);
      process.stdout.on('resize', sendResize);
      sendResize();
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (typeof data === 'string') {
        process.stdout.write(sanitizePtyChunk(data));
      } else if (data instanceof ArrayBuffer) {
        process.stdout.write(sanitizePtyChunk(Buffer.from(data).toString()));
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => process.stdout.write(sanitizePtyChunk(Buffer.from(buf).toString())));
      }
    };

    ws.onclose = (event: CloseEvent) => {
      process.stdout.write(
        `\n${C.dim}Disconnected${event.reason ? `: ${event.reason}` : ''}.${C.reset}\n`,
      );
      finish(0);
    };

    ws.onerror = () => {
      process.stderr.write(`${status.err('Terminal connection failed.')}\n`);
      finish(1);
    };
  });
}
