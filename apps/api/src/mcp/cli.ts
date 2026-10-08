/**
 * The `kortix` tool of the hosted MCP server: it runs the real `kortix` CLI as
 * the signed-in user, so every CLI command is reachable without one MCP tool
 * per subcommand. Safety rules, each pinned by cli.test.ts:
 *   - argv array, never a shell;
 *   - an env built from scratch (the API process holds every server secret):
 *     the caller's own token and this API's loopback URL are the only credentials;
 *   - a fresh empty cwd and HOME, removed after the run;
 *   - commands that print the token, reach another server, need a terminal or
 *     read local files are refused before any process starts (DENY_*);
 *   - a timeout, an output cap and at most MAX_CONCURRENT children per API task.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Denial {
  reason: string;
  use: string;
}

/** First word → refusal. Every top-level command of the CLI is here or in CLI_ALLOWED (cli.test.ts fails otherwise). */
export const DENY_COMMANDS: Record<string, Denial> = {
  hosts: { reason: 'it signs in to, or switches to, another server and would send your token there', use: 'this server already acts as you' },
  login: { reason: 'it opens a browser sign-in and stores a token', use: 'you are already signed in through the MCP connection' },
  logout: { reason: 'it edits the sign-in state of a machine', use: 'disconnect the MCP server in your client' },
  init: { reason: 'it writes a new project into a local directory', use: 'start_session, or `projects create`' },
  ship: { reason: 'it pushes a local directory', use: 'run_command in a session sandbox, where the source lives' },
  deploy: { reason: 'it pushes a local directory', use: 'run_command in a session sandbox, where the source lives' },
  update: { reason: 'it replaces the CLI binary of a machine', use: 'nothing: the server has its own CLI' },
  uninstall: { reason: 'it removes the CLI from a machine', use: 'nothing' },
  'self-host': { reason: 'it runs Docker on a machine', use: 'nothing' },
  tui: { reason: 'it is an interactive terminal app', use: 'the other MCP tools' },
  t: { reason: 'it is an interactive terminal app', use: 'the other MCP tools' },
  connect: { reason: 'it attaches an interactive terminal to a session', use: 'start_session and send_message' },
  attach: { reason: 'it attaches an interactive terminal to a session', use: 'start_session and send_message' },
  token: { reason: 'it prints the raw access token', use: '`whoami --json` names the user' },
};

/** [command, subcommand] → refusal. */
export const DENY_SUBCOMMANDS: { path: [string, string]; denial: Denial }[] = [
  { path: ['env', 'pull'], denial: { reason: 'it writes a local file', use: '`secrets ls` and `secrets set`' } },
  { path: ['env', 'push'], denial: { reason: 'it reads a local file', use: '`secrets set KEY=value`' } },
  { path: ['apps', 'deploy'], denial: { reason: 'it deploys a local directory, and this server has none', use: 'run_command in a session sandbox, where the source lives: `kortix apps deploy <path>` there' } },
  { path: ['backends', 'deploy'], denial: { reason: 'it deploys a local directory, and this server has none', use: 'run_command in a session sandbox, where the source lives: `kortix backends deploy <name> --dir <path>` there' } },
  { path: ['backends', 'token'], denial: { reason: 'it prints a sign-in token for a backend into this conversation', use: 'run_command in a session sandbox: `kortix backends token <name>` there' } },
  { path: ['backends', 'env'], denial: { reason: 'it prints a backend admin key into this conversation', use: 'run_command in a session sandbox: `eval "$(kortix backends env <name>)"` keeps the key in the shell' } },
  ...['connect', 'attach', 'shell', 'terminal', 'ssh', 'forward', 'ports'].flatMap((sub) =>
    ['sessions', 'session'].map((cmd) => ({ path: [cmd, sub] as [string, string], denial: { reason: 'it needs an interactive terminal or a long-lived connection', use: 'start_session, send_message, read_session, run_command' } })),
  ),
];

/** Top-level commands that run. `whoami --token-only`, `chat` without `--prompt` and `--host` are refused by `denial()`. */
export const CLI_ALLOWED = [
  'whoami', 'doctor', 'validate', 'schema', 'accounts', 'members', 'groups', 'tokens', 'billing', 'projects',
  'sessions', 'session', 'chat', 'files', 'cr', 'review', 'triggers', 'reminders', 'remind', 'connectors',
  'secrets', 'providers', 'env', 'gateway', 'apps', 'backends', 'channels', 'sandboxes', 'marketplace', 'system-skills',
  'skills', 'registry', 'agents', 'models', 'access', 'roles', 'permissions', 'perms', 'audit', 'grants', 'feedback', 'help', 'version',
];

export function denial(args: string[]): Denial | null {
  if (args.some((a) => a === '--host' || a.startsWith('--host='))) {
    return { reason: '--host points the CLI at another server and would send your token there', use: 'this server already acts as you' };
  }
  const [command = '', sub = ''] = args;
  const top = Object.hasOwn(DENY_COMMANDS, command) ? DENY_COMMANDS[command]! : undefined;
  if (top) return top;
  // Only a known command may lead: a leading flag must never reach a command this table did not see.
  if (!CLI_ALLOWED.includes(command) && command !== '--help' && command !== '-h') {
    return { reason: `\`${command.slice(0, 40)}\` is not a kortix command`, use: '["--help"] lists the commands' };
  }
  const nested = DENY_SUBCOMMANDS.find((d) => d.path[0] === command && d.path[1] === sub);
  if (nested) return nested.denial;
  if (command === 'whoami' && args.includes('--token-only')) return DENY_COMMANDS.token!;
  const oneShot = args.includes('--prompt') || args.includes('-p') || args.some((a) => a.startsWith('--prompt='));
  if ((command === 'chat' || ((command === 'sessions' || command === 'session') && (sub === 'chat' || sub === 'talk'))) && !oneShot) {
    return { reason: 'without --prompt it opens an interactive chat', use: 'start_session and send_message, or add --prompt "<text>"' };
  }
  return null;
}

// ─── The binary ─────────────────────────────────────────────────────────────

// apps/api/src/mcp → the repo root. In the API image the same layout sits under /app.
const REPO_ROOT = resolve(import.meta.dir, '../../../..');

/** argv prefixes that start the CLI, best first: the compiled binary (API image), then the source under bun (dev, flows). */
export function resolveCli(root = REPO_ROOT, bun = process.execPath): string[][] {
  const binary = process.env.KORTIX_MCP_CLI_BIN || join(root, 'apps/cli/dist/kortix');
  const source = join(root, 'apps/cli/src/index.ts');
  return [...(existsSync(binary) ? [[binary]] : []), ...(existsSync(source) ? [[bun, source]] : [])];
}

// ─── The environment ────────────────────────────────────────────────────────

/** Exactly these keys, never `process.env`. */
export function cliEnv(input: { token: string; apiUrl: string; home: string; tmp: string; projectId?: string; sessionId?: string }): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: input.home,
    TMPDIR: input.tmp,
    NO_COLOR: '1',
    CI: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_API_URL: input.apiUrl,
    KORTIX_TOKEN: input.token,
    // The CLI would read a sandbox env file for unset keys; the server has none to offer.
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    ...(input.projectId ? { KORTIX_PROJECT_ID: input.projectId } : {}),
    ...(input.sessionId ? { KORTIX_SESSION_ID: input.sessionId } : {}),
  };
}

// ─── Running ────────────────────────────────────────────────────────────────

export const MAX_CONCURRENT = 4;
const STDOUT_CAP = 45_000;
const STDERR_CAP = 8_000;
/** `text()` cuts at 60 000 characters; the JSON around the streams must stay whole. */
const RESULT_CAP = 55_000;
let running = 0;

/** Reads a stream up to `cap` bytes; keeps draining past it so the child never blocks on a full pipe. */
function capture(stream: ReadableStream<Uint8Array>, cap: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;
  const done = (async () => {
    for (;;) {
      const { done: end, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (end || !value) return;
      const part = value.subarray(0, Math.max(cap - kept, 0));
      if (part.length) chunks.push(part);
      kept += part.length;
      if (part.length < value.length) truncated = true;
    }
  })();
  return {
    done,
    stop: () => reader.cancel().catch(() => {}),
    result: () => ({ text: Buffer.concat(chunks).toString('utf8'), truncated }),
  };
}

export type CliRun = { ok: true; json: string; exitCode: number } | { ok: false; error: string };

export async function runCli(input: {
  args: string[];
  token: string;
  apiUrl: string;
  projectId?: string;
  sessionId?: string;
  timeoutMs: number;
  /** Tests only: the argv prefix to run instead of the CLI. */
  cli?: string[][];
}): Promise<CliRun> {
  const denied = denial(input.args);
  if (denied) return { ok: false, error: `Refused: \`kortix ${input.args.join(' ').slice(0, 80)}\` — ${denied.reason}. Use instead: ${denied.use}.` };
  const candidates = input.cli ?? resolveCli();
  if (candidates.length === 0) return { ok: false, error: 'CLI not available on this server. Use call_api (search_api finds the route) for the same operation.' };
  if (running >= MAX_CONCURRENT) return { ok: false, error: `Busy: ${MAX_CONCURRENT} kortix commands are already running on this server. Retry in a few seconds.` };
  running++;
  const root = mkdtempSync(join(tmpdir(), 'kortix-mcp-'));
  try {
    const [home, work, tmp] = ['home', 'work', 'tmp'].map((d) => join(root, d));
    for (const d of [home!, work!, tmp!]) mkdirSync(d);
    const spawnEnv = cliEnv({ token: input.token, apiUrl: input.apiUrl, home: home!, tmp: tmp!, projectId: input.projectId, sessionId: input.sessionId });
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    let spawnError = '';
    // A binary built for another platform (ENOEXEC) falls through to the next candidate.
    for (const cli of candidates) {
      try {
        proc = Bun.spawn([...cli, ...input.args], { cwd: work, env: spawnEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        break;
      } catch (err) {
        spawnError = err instanceof Error ? err.message : String(err);
      }
    }
    if (!proc) return { ok: false, error: `CLI not available on this server (${spawnError.slice(0, 200)}). Use call_api (search_api finds the route) for the same operation.` };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, input.timeoutMs);
    const streams = [capture(proc.stdout, STDOUT_CAP), capture(proc.stderr, STDERR_CAP)] as const;
    const exitCode = await proc.exited;
    clearTimeout(timer);
    // A grandchild that outlives the CLI can hold the pipes open: give the readers a second, then close them.
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(streams.map((x) => x.done)), new Promise((r) => (grace = setTimeout(r, 1_000)))]);
    clearTimeout(grace);
    await Promise.all(streams.map((x) => x.stop()));
    const [out, err] = [streams[0].result(), streams[1].result()];
    // `--json` output travels as a JSON value, not an escaped string: half the size, and usable as is.
    const parsedJson = (text: string): unknown => {
      if (!/^\s*[[{]/.test(text)) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };
    const render = (stdoutText: string) => {
      const value = out.truncated ? undefined : parsedJson(stdoutText);
      return JSON.stringify({
        exit_code: timedOut ? null : exitCode,
        ...(timedOut ? { timed_out: `killed after ${Math.round(input.timeoutMs / 1000)} s` } : {}),
        ...(value !== undefined ? { json: value } : { stdout: stdoutText }),
        stderr: err.text,
        ...(out.truncated || err.truncated
          ? { truncated: `output cut (stdout ${STDOUT_CAP}, stderr ${STDERR_CAP} characters max); cut JSON is not valid JSON. Narrow the command: a filter, a --limit, or one item instead of a list` }
          : {}),
      });
    };
    let stdoutText = out.text;
    let json = render(stdoutText);
    // Quotes and newlines double in JSON: shrink stdout until the whole reply fits.
    while (json.length > RESULT_CAP && stdoutText.length > 1_000) {
      stdoutText = stdoutText.slice(0, Math.floor(stdoutText.length * 0.7));
      out.truncated = true;
      json = render(stdoutText);
    }
    return { ok: true, json, exitCode: timedOut ? -1 : exitCode };
  } finally {
    running--;
    rmSync(root, { recursive: true, force: true });
  }
}

export const KORTIX_TOOL = {
  name: 'kortix',
  title: 'Run the kortix CLI',
  description:
    'Run the real `kortix` CLI as you: everything the CLI does (secrets, triggers, cr, review, reminders, agents, models, gateway, providers, channels, sandboxes, apps, marketplace, files, access, roles, permissions, audit, grants, members, groups, tokens, billing, projects, sessions, system-skills, …). `args` is the argv after `kortix`, e.g. ["secrets","ls","--json"]. Discover with ["--help"] and ["<group>","--help"]; prefer `--json` for output you parse. `project_id` sets the project the command runs in; `session_id` sets the session where a command takes one. Returns {exit_code, stdout (or json: the parsed value when the output is JSON, e.g. with --json), stderr}; a non-zero exit code is `isError`. First-class tools exist for sessions, sandbox files and connectors: prefer start_session, run_command, read_file and call_connector to this one. Refused before it runs: `--host`, hosts, login, logout, init, ship, update, uninstall, self-host, tui, connect, chat without --prompt, token, env pull|push, apps deploy (a local directory: use run_command in a session sandbox). Commands time out after about 45 seconds.',
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'The argv after `kortix`, one array element per argument, e.g. ["triggers","ls","--json"]. Never a shell line.' },
      project_id: { type: 'string', description: 'The project_id (UUID), from list_projects. Sets the project for project-scoped commands.' },
      session_id: { type: 'string', description: 'The session_id (UUID) for commands that act on the current session, e.g. ["remind","check the build","--in","1h"].' },
    },
    required: ['args'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
} as const;

/** Validated `args`: at most 64 strings of at most 8 000 characters. */
export function parseArgs(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return 'args must be a non-empty array of at most 64 strings, e.g. ["secrets","ls","--json"]';
  if (value.some((a) => typeof a !== 'string' || a.length > 8_000 || a.includes('\0'))) return 'every element of args must be a string of at most 8000 characters';
  return value as string[];
}
