/**
 * One run of the unmodified Claude Code binary's `claude setup-token`.
 *
 * The command signs a member in to their own Claude subscription through
 * Anthropic's own flow: it prints a claude.com authorize URL, the member
 * approves there, platform.claude.com shows a code, and the member pastes the
 * code back. The binary exchanges it and prints a long-lived token that only
 * makes model requests. Kortix never builds the URL or exchanges the code: the
 * binary does both.
 *
 * The command draws a terminal UI, so it runs under `script`, which gives it a
 * pseudo-terminal. The terminal is 1000 columns wide so that the URL and the
 * token print on one line each. The process gets its own empty HOME and
 * CLAUDE_CONFIG_DIR, and a PATH where `xdg-open` does nothing: the binary must
 * never open a browser on the host.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

/** A failure the member can act on. `code` is part of the HTTP contract. */
export class SetupTokenError extends Error {
  constructor(
    readonly code: 'claude_unavailable' | 'start_timeout' | 'invalid_code' | 'login_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SetupTokenError';
  }
}

// CSI (`ESC [ … letter`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and other
// two-byte escapes. The OSC-8 hyperlink target is read before this strip.
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_RE = /\u001b\[[0-9;?<>=]*[ -/]*[@-~]/g;
const ESC_RE = /\u001b[@-Z\\-_]/g;

export function stripTerminal(raw: string): string {
  return raw.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_RE, '').replace(/\r/g, '');
}

const AUTHORIZE_PREFIX = /^https:\/\/(?:claude\.com|claude\.ai)\//;

/**
 * The authorize URL the binary printed, or null while it has printed none.
 * The OSC-8 hyperlink carries the whole URL even when the visible text wraps,
 * so it is read first; the visible text is the fallback.
 */
export function parseAuthorizeUrl(raw: string): string | null {
  for (const match of raw.matchAll(/\u001b\]8;[^;\u0007\u001b]*;(https:\/\/[^\u0007\u001b\s]+)/g)) {
    const url = match[1]!;
    if (AUTHORIZE_PREFIX.test(url) && url.includes('oauth/authorize')) return url;
  }
  const text = stripTerminal(raw);
  const visible = text.match(/https:\/\/(?:claude\.com|claude\.ai)\/\S*oauth\/authorize\?\S+/);
  return visible ? visible[0] : null;
}

/**
 * The token the binary printed after a successful exchange, or null. A token
 * that wraps is joined: the token is everything from its prefix up to the
 * next sentence, without whitespace.
 */
export function parseToken(raw: string): string | null {
  const text = stripTerminal(raw);
  const start = text.indexOf('sk-ant-oat01-');
  if (start < 0) return null;
  const rest = text.slice(start);
  const end = rest.search(/\n\s*\n|Store this token|Use this token/i);
  const token = (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, '');
  const match = token.match(/^sk-ant-oat01-[A-Za-z0-9_-]+/);
  return match && CLAUDE_TOKEN_PATTERN.test(match[0]) ? match[0] : null;
}

/** The binary reports a code it could not exchange. */
export function parseLoginError(raw: string): string | null {
  const text = stripTerminal(raw);
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /(oauth error|invalid (code|grant|authorization)|authentication failed|login failed|error:)/i.test(entry));
  return line ? line.slice(0, 300) : null;
}

// The API answers a request within 25 s (middleware/request-deadline.ts), and
// `start` and `complete` each wait on the binary inside one request. The binary
// prints the link in ~4 s and Anthropic answers a code in ~2 s.
const START_TIMEOUT_MS = 20_000;
const SUBMIT_TIMEOUT_MS = 15_000;
const ECHO_WAIT_MS = 2_000;
/** Longer than a terminal read takes, so the binary reads Enter as its own key. */
const ENTER_GAP_MS = 200;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface SetupTokenRun {
  /** The claude.com URL the member opens. */
  readonly authorizeUrl: string;
  /** Paste the code; resolves with the token, or rejects with a SetupTokenError. */
  submit(code: string, timeoutMs?: number): Promise<string>;
  /** Stop the process and delete its directories. Safe to call more than once. */
  stop(): void;
}

export interface SetupTokenOptions {
  /** The `claude` executable: a name on PATH or an absolute path. */
  claudePath: string;
  /** The `script` executable that gives the binary a pseudo-terminal. */
  scriptPath?: string;
  startTimeoutMs?: number;
}

/** Start `claude setup-token` and wait until it prints the authorize URL. */
export async function startSetupToken(options: SetupTokenOptions): Promise<SetupTokenRun> {
  const claude = options.claudePath.includes('/') ? (existsSync(options.claudePath) ? options.claudePath : null) : Bun.which(options.claudePath);
  const script = options.scriptPath ?? Bun.which('script');
  if (!claude) throw new SetupTokenError('claude_unavailable', 'Claude Code is not installed on this server');
  if (!script) throw new SetupTokenError('claude_unavailable', 'The terminal helper `script` is not installed on this server');

  const home = mkdtempSync(join(tmpdir(), 'kortix-claude-login-'));
  const bin = join(home, 'bin');
  // A browser opener that does nothing, ahead of the system PATH.
  mkdirSync(bin, { recursive: true });
  for (const name of ['xdg-open', 'open', 'sensible-browser', 'www-browser']) {
    const shim = join(bin, name);
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);
  }

  let output = '';
  let exited = false;
  let stopped = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const command = `stty cols 1000 rows 50 2>/dev/null; exec ${shellQuote(claude)} setup-token`;
  const child = Bun.spawn([script, '-qfec', command, '/dev/null'], {
    cwd: home,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      TERM: 'xterm-256color',
      COLUMNS: '1000',
      LINES: '50',
      LANG: 'C.UTF-8',
      BROWSER: join(bin, 'xdg-open'),
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
  });

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      // Bound memory: the spinner redraws forever while the member is away.
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
      notify();
    }
  };
  void pump(child.stdout).catch(() => {});
  void pump(child.stderr).catch(() => {});
  void child.exited.then(() => {
    exited = true;
    notify();
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(home, { recursive: true, force: true });
  };

  /** Wait until `check` returns a value, the process exits, or the time runs out. */
  const waitFor = <T>(check: () => T | null, timeoutMs: number): Promise<T | null> =>
    new Promise((resolve) => {
      const done = (value: T | null) => {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(value);
      };
      const listener = () => {
        const value = check();
        if (value !== null) return done(value);
        if (exited) done(null);
      };
      const timer = setTimeout(() => done(check()), timeoutMs);
      listeners.add(listener);
      listener();
    });

  const authorizeUrl = await waitFor(() => parseAuthorizeUrl(output), options.startTimeoutMs ?? START_TIMEOUT_MS);
  if (!authorizeUrl) {
    stop();
    throw new SetupTokenError('start_timeout', 'Claude Code did not print a sign-in link');
  }

  return {
    authorizeUrl,
    stop,
    async submit(code: string, timeoutMs = SUBMIT_TIMEOUT_MS) {
      if (stopped || exited) throw new SetupTokenError('login_failed', 'The Claude sign-in stopped. Start it again.');
      const before = output.length;
      // The binary reads the terminal in chunks, and an Enter in the same chunk
      // as the code is part of the paste: the prompt shows the masked code and
      // waits. So the code goes first, and Enter goes alone once the prompt
      // echoed it.
      child.stdin.write(code.trim());
      await child.stdin.flush();
      await waitFor(() => (output.length > before ? true : null), ECHO_WAIT_MS);
      await Bun.sleep(ENTER_GAP_MS);
      child.stdin.write('\r');
      await child.stdin.flush();
      const outcome = await waitFor<{ token: string } | { error: string }>(() => {
        const token = parseToken(output);
        if (token) return { token };
        const error = parseLoginError(output.slice(before));
        return error ? { error } : null;
      }, timeoutMs);
      if (outcome && 'token' in outcome) return outcome.token;
      if (outcome && 'error' in outcome) throw new SetupTokenError('invalid_code', 'Claude did not accept that code. Copy the code again and paste it.');
      throw new SetupTokenError('login_failed', 'Claude Code did not finish the sign-in');
    },
  };
}
