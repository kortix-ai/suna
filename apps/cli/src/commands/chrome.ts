/**
 * `kortix chrome` — drive the user's own Chrome from a Kortix session.
 *
 * The user installs the Kortix Chrome extension; `use` asks the sandbox daemon
 * (kortixd) to attach it, after which `agent-browser --cdp 9333 …` controls
 * that Chrome. Protocol: .agents/skills/kortix-chrome/references/protocol.md.
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

const HELP = help`Usage: kortix chrome <subcommand> [options]

Control the user's own Chrome (their logins, their real session) from this
session. The user installs the Kortix extension once; see
https://kortix.com/settings/chrome.

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
  kortix chrome use
  agent-browser --cdp 9333 open https://example.com
  kortix chrome release
`;

interface ChromeInfo {
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
const CONNECT_CODES = new Set(['chrome_not_connected', 'chrome_offline']);

/** "Chrome · Work (macOS)"; the OS once, also when the name already says it. */
export function chromeLabel(b: ChromeInfo): string {
  const name = b.name || b.brand || 'Browser';
  return b.os && !name.includes(b.os) ? `${name} (${b.os})` : name;
}

export function formatUsed(b: ChromeInfo, port = CDP_PORT): string {
  return [
    status.ok(`Using ${chromeLabel(b)}`),
    b.tabScope === 'own'
      ? `     ${C.dim}Tabs:${C.reset} only the tabs you open (the user chose this; their other tabs are hidden)`
      : `     ${C.dim}Tabs:${C.reset} all of the user's tabs, every window (\`agent-browser --cdp ${port} tab list\`); you start in a tab of your own`,
    `     ${C.dim}Drive it:${C.reset} agent-browser --cdp ${port} open https://example.com`,
  ].join('\n');
}

export function formatChromeError(body: ErrorBody): string {
  const lines = [status.err(body.error || 'The browser request failed.')];
  if (body.connectUrl && body.code && CONNECT_CODES.has(body.code)) {
    const ask = body.code === 'chrome_offline' ? 'Ask the user to open Chrome, or check it here' : 'Ask the user to connect one';
    lines.push(`     ${ask}: ${C.cyan}${body.connectUrl}${C.reset}`);
  } else if (body.code === 'chrome_denied') {
    lines.push('     Do not retry without asking the user. If they agree, run: kortix chrome use --ask');
  }
  return lines.join('\n');
}

export function formatChromeList(list: ChromeInfo[], connectUrl?: string): string {
  if (list.length === 0) {
    return [
      status.err('No browser is connected to Kortix.'),
      ...(connectUrl ? [`     Ask the user to connect one: ${C.cyan}${connectUrl}${C.reset}`] : []),
    ].join('\n');
  }
  return list
    .map((b) => `  ${b.online ? C.green + '●' : C.dim + '○'}${C.reset}  ${chromeLabel(b)}  ${C.dim}${b.online ? 'online' : 'offline'} · ${b.accessMode ?? 'always'} · ${b.tabScope === 'own' ? 'own' : 'all'} tabs${C.reset}`)
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
  const { status: code, text } = await sandboxDaemonRequest(d.base, d.token, method, `/kortix/chrome/${path}`, body, 180_000);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }
  return { status: code, body: parsed };
}

const NOT_IN_SESSION =
  '`kortix chrome use` runs only inside a Kortix session. Start or open a session and run it there.';

export async function runChrome(argv: string[]): Promise<number> {
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
      const list = await ctx.client.get<ChromeInfo[]>('/chrome/connections');
      if (json) emitJson(list);
      else process.stdout.write(`${formatChromeList(list, `${webBase(ctx.client.apiBase)}/settings/chrome`)}\n`);
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  if (sub !== 'use' && sub !== 'status' && sub !== 'release') {
    return fail(`Unknown subcommand "${sub}". Run \`kortix chrome --help\`.`);
  }
  const d = daemon();
  if (!d) {
    if (json) emitJson({ error: NOT_IN_SESSION, code: 'chrome_not_in_session' });
    else process.stderr.write(`${status.err(NOT_IN_SESSION)}\n`);
    return 1;
  }

  let res: Awaited<ReturnType<typeof callDaemon>>;
  try {
    if (sub === 'use') res = await callDaemon(d, 'POST', 'attach', { chrome: rest[0], ask });
    else if (sub === 'release') res = await callDaemon(d, 'POST', 'release', {});
    else res = await callDaemon(d, 'GET', 'status');
  } catch (err) {
    const msg = `Could not reach the sandbox daemon: ${(err as Error).message}`;
    if (json) emitJson({ error: msg, code: 'chrome_daemon_unreachable' });
    else process.stderr.write(`${status.err(msg)}\n`);
    return 1;
  }

  if (res.status >= 400) {
    if (json) emitJson(res.body);
    else process.stderr.write(`${formatChromeError(res.body as ErrorBody)}\n`);
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
    process.stdout.write(`${formatUsed(res.body.chrome as ChromeInfo, Number(res.body.cdpPort) || CDP_PORT)}\n`);
  } else if (res.body.attached) {
    const clients = Number(res.body.clients) || 0;
    process.stdout.write(
      `${status.ok(`Attached: ${chromeLabel(res.body.chrome as ChromeInfo)} · ${clients} CDP client${clients === 1 ? '' : 's'}`)}\n`,
    );
  } else {
    process.stdout.write(`${status.info('No browser attached. Run: kortix chrome use')}\n`);
  }
  return 0;
}

function webBase(apiBase: string): string {
  return (sandboxEnvValue('KORTIX_FRONTEND_URL') || apiBase.replace('://api.', '://').replace(/\/v1\/?$/, '')).replace(/\/+$/, '');
}
