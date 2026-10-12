/**
 * `kortix browser` — drive the user's own Chrome from a Kortix session.
 *
 * The user installs the Kortix Chrome extension; `use` asks the sandbox daemon
 * (kortixd) to attach it, after which `agent-browser --cdp 9333 …` controls
 * that Chrome. Protocol: .agents/skills/kortix-browser/references/protocol.md.
 * `ls` talks to the API; use/status/release talk to kortixd on loopback.
 */
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { sandboxEnvValue } from '../api/sandbox-env.ts';
import { sandboxDaemonRequest } from '../api/sdk.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix browser <subcommand> [options]

Control the user's own Chrome (their logins, their real session) from this
session. The user installs the Kortix extension once; see
https://kortix.com/settings/browsers.

Subcommands:
  ls                    List the user's connected browsers.
  use [name] [--ask]    Attach a browser to this session. Then run
                        \`agent-browser --cdp 9333 …\`. --ask forces a fresh
                        permission prompt in Chrome.
  status                Show whether a browser is attached.
  release               Detach the browser. Do this when the task is done.

Options:
  --json              Machine-readable output.
  -h, --help          Show this help.

Examples:
  kortix browser use
  agent-browser --cdp 9333 open https://example.com
  kortix browser release
`;

interface BrowserInfo {
  id?: string;
  name?: string;
  brand?: string;
  os?: string;
  online?: boolean;
  profileLabel?: string | null;
  accessMode?: string;
  tabScope?: string;
}

interface ErrorBody {
  error?: string;
  code?: string;
  connectUrl?: string;
}

const CDP_PORT = 9333;
const CONNECT_CODES = new Set(['browser_not_connected', 'browser_offline']);

/** "Chrome · Work (macOS)"; the OS once, also when the name already says it. */
export function browserLabel(b: BrowserInfo): string {
  const name = b.name || b.brand || 'Browser';
  return b.os && !name.includes(b.os) ? `${name} (${b.os})` : name;
}

export function formatUsed(b: BrowserInfo, port = CDP_PORT): string {
  return [
    status.ok(`Using ${browserLabel(b)}`),
    b.tabScope === 'own'
      ? `     ${C.dim}Tabs:${C.reset} only the tabs you open (the user chose this; their other tabs are hidden)`
      : `     ${C.dim}Tabs:${C.reset} all of the user's tabs, every window (\`agent-browser --cdp ${port} tab list\`); you start in a tab of your own`,
    `     ${C.dim}Drive it:${C.reset} agent-browser --cdp ${port} open https://example.com`,
  ].join('\n');
}

export function formatBrowserError(body: ErrorBody): string {
  const lines = [status.err(body.error || 'The browser request failed.')];
  if (body.connectUrl && body.code && CONNECT_CODES.has(body.code)) {
    const ask = body.code === 'browser_offline' ? 'Ask the user to open Chrome, or check it here' : 'Ask the user to connect one';
    lines.push(`     ${ask}: ${C.cyan}${body.connectUrl}${C.reset}`);
  } else if (body.code === 'browser_denied') {
    lines.push('     Do not retry without asking the user. If they agree, run: kortix browser use --ask');
  }
  return lines.join('\n');
}

export function formatBrowserList(list: BrowserInfo[], connectUrl?: string): string {
  if (list.length === 0) {
    return [
      status.err('No browser is connected to Kortix.'),
      ...(connectUrl ? [`     Ask the user to connect one: ${C.cyan}${connectUrl}${C.reset}`] : []),
    ].join('\n');
  }
  return list
    .map((b) => `  ${b.online ? C.green + '●' : C.dim + '○'}${C.reset}  ${browserLabel(b)}  ${C.dim}${b.online ? 'online' : 'offline'} · ${b.accessMode ?? 'always'} · ${b.tabScope === 'own' ? 'own' : 'all'} tabs${C.reset}`)
    .join('\n');
}

interface Daemon {
  base: string;
  token: string;
}

function daemon(): Daemon | null {
  const token = sandboxEnvValue('KORTIX_TOKEN');
  if (!token) return null;
  const port = process.env.KORTIX_SERVICE_PORT?.trim() || '8000';
  return { base: `http://127.0.0.1:${port}`, token };
}

async function callDaemon(
  d: Daemon,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // `use` can wait for the user to answer a prompt in Chrome.
  const { status: code, text } = await sandboxDaemonRequest(d.base, d.token, method, `/kortix/browser/${path}`, body, 180_000);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  return { status: code, body: parsed };
}

const NOT_IN_SESSION =
  '`kortix browser use` runs only inside a Kortix session. Start or open a session and run it there.';

export async function runBrowser(argv: string[]): Promise<number> {
  const h = splitHelp(argv, HELP);
  if (h !== null) return h;
  const rest = [...argv];
  let json: boolean;
  let ask: boolean;
  let host: string | undefined;
  try {
    json = takeFlagBool(rest, ['--json']);
    ask = takeFlagBool(rest, ['--ask']);
    host = takeFlagValue(rest, ['--host']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const sub = rest.shift();

  if (sub === 'ls' || sub === 'list') {
    const ctx = await resolveProjectContext({ hostArg: host });
    if (!ctx) return 1;
    try {
      const list = await ctx.client.get<BrowserInfo[]>('/browsers');
      if (json) emitJson(list);
      else process.stdout.write(`${formatBrowserList(list, `${webBase(ctx.client.apiBase)}/settings/browsers`)}\n`);
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  if (sub !== 'use' && sub !== 'status' && sub !== 'release') {
    return fail(`Unknown subcommand "${sub}". Run \`kortix browser --help\`.`);
  }
  const d = daemon();
  if (!d) {
    if (json) emitJson({ error: NOT_IN_SESSION, code: 'browser_not_in_session' });
    else process.stderr.write(`${status.err(NOT_IN_SESSION)}\n`);
    return 1;
  }

  let res: Awaited<ReturnType<typeof callDaemon>>;
  try {
    if (sub === 'use') res = await callDaemon(d, 'POST', 'attach', { browser: rest[0], ask });
    else if (sub === 'release') res = await callDaemon(d, 'POST', 'release', {});
    else res = await callDaemon(d, 'GET', 'status');
  } catch (err) {
    const msg = `Could not reach the sandbox daemon: ${(err as Error).message}`;
    if (json) emitJson({ error: msg, code: 'browser_daemon_unreachable' });
    else process.stderr.write(`${status.err(msg)}\n`);
    return 1;
  }

  if (res.status >= 400) {
    if (json) emitJson(res.body);
    else process.stderr.write(`${formatBrowserError(res.body as ErrorBody)}\n`);
    return 1;
  }
  if (sub === 'release') {
    if (json) emitJson({ released: true });
    else process.stdout.write(`${status.ok('Browser released.')}\n`);
    return 0;
  }
  if (json) {
    emitJson(res.body);
    return 0;
  }
  if (sub === 'use') {
    process.stdout.write(`${formatUsed(res.body.browser as BrowserInfo, Number(res.body.cdpPort) || CDP_PORT)}\n`);
  } else if (res.body.attached) {
    const clients = Number(res.body.clients) || 0;
    process.stdout.write(
      `${status.ok(`Attached: ${browserLabel(res.body.browser as BrowserInfo)} · ${clients} CDP client${clients === 1 ? '' : 's'}`)}\n`,
    );
  } else {
    process.stdout.write(`${status.info('No browser attached. Run: kortix browser use')}\n`);
  }
  return 0;
}

function webBase(apiBase: string): string {
  return (sandboxEnvValue('KORTIX_FRONTEND_URL') || apiBase.replace('://api.', '://').replace(/\/v1\/?$/, '')).replace(/\/+$/, '');
}
