/**
 * Kortix-native PTY client — the daemon `/kortix/pty` endpoints
 * (routes/pty.ts in kortix-sandbox-agent-server), owned by the SDK.
 * Independent of whatever agent runtime (OpenCode today) is running in the
 * sandbox — a raw terminal shouldn't go down with the agent.
 *
 * Response shape matches OpenCode's own `Pty` entity 1:1 (id/title/command/
 * args/cwd/status/pid/exitCode), so this is a drop-in swap for callers
 * already built against that contract.
 *
 * Every call takes an explicit `baseUrl` (same convention as `env.ts`/
 * `triggers.ts`) rather than reading the module-global "active runtime" —
 * a caller keyed to a specific sandbox instance must talk to THAT instance.
 */
import { authenticatedFetch, getAuthToken } from '../http/auth';
import { stripTrailingSlashes } from '../../platform/strings';

export interface KortixPty {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
  exitCode?: number;
}

async function ptyErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}) as { error?: string; message?: string });
  return body?.error || body?.message || res.statusText || fallback;
}

function requireBaseUrl(baseUrl: string): string {
  if (!baseUrl) {
    throw new Error('[kortix-pty] Server URL not ready — sandbox is still loading');
  }
  return stripTrailingSlashes(baseUrl);
}

/** List running/exited terminals. Daemon `GET /kortix/pty`. */
export async function listKortixPty(baseUrl: string): Promise<KortixPty[]> {
  const url = requireBaseUrl(baseUrl);
  const res = await authenticatedFetch(`${url}/kortix/pty`);
  if (!res.ok) throw new Error(await ptyErrorMessage(res, 'Failed to list terminals'));
  return res.json();
}

/** Spawn a new terminal. Daemon `POST /kortix/pty`. */
export async function createKortixPty(
  baseUrl: string,
  body?: { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> },
): Promise<KortixPty> {
  const url = requireBaseUrl(baseUrl);
  const res = await authenticatedFetch(`${url}/kortix/pty`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(await ptyErrorMessage(res, 'Failed to create terminal'));
  return res.json();
}

/** Rename/resize a terminal. Daemon `PATCH /kortix/pty/:id`. */
export async function updateKortixPty(
  baseUrl: string,
  ptyId: string,
  body: { title?: string; size?: { rows: number; cols: number } },
): Promise<KortixPty> {
  const url = requireBaseUrl(baseUrl);
  const res = await authenticatedFetch(`${url}/kortix/pty/${encodeURIComponent(ptyId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await ptyErrorMessage(res, 'Failed to update terminal'));
  return res.json();
}

/** Kill + remove a terminal. Daemon `DELETE /kortix/pty/:id`. */
export async function removeKortixPty(baseUrl: string, ptyId: string): Promise<void> {
  const url = requireBaseUrl(baseUrl);
  const res = await authenticatedFetch(`${url}/kortix/pty/${encodeURIComponent(ptyId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await ptyErrorMessage(res, 'Failed to remove terminal'));
}

/**
 * WebSocket URL for a terminal's live stream — same http→ws conversion,
 * mixed-content upgrade, and `?token=` query auth (WebSocket can't set
 * custom headers) the OpenCode-backed terminal used, just pointed at
 * `/kortix/pty` instead of OpenCode's `/pty`.
 *
 * `opts.wake` marks the attach as USER-INITIATED (the panel opened, or a person
 * pressed a control). A parked sandbox refuses the upgrade with 503, which the
 * browser can only surface as close code 1006 — so without this marker the
 * terminal reconnects forever against a box that nothing in the loop will ever
 * wake. The API resumes a stopped box only for a marked attach
 * (`shouldWakeStoppedSandboxForWsAttach`). The wake is asynchronous: the row
 * stays `stopped` until the provider confirms the box, so a caller keeps the
 * marker on its retries until the attach opens, and drops it after that. A
 * socket that later drops because the box parked must not resurrect it.
 */
export async function getKortixPtyWebSocketUrl(
  ptyId: string,
  baseUrl: string,
  opts?: { wake?: boolean },
): Promise<string> {
  const base = requireBaseUrl(baseUrl);
  const wsBase = (() => {
    try {
      const parsed = new URL(base);
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      // Browsers block ws:// from an https page (mixed content) — force wss:
      // in that case rather than fail a deployment-only combination.
      if (typeof window !== 'undefined' && window.location.protocol === 'https:' && parsed.protocol === 'ws:') {
        parsed.protocol = 'wss:';
      }
      return stripTrailingSlashes(parsed.toString());
    } catch {
      return base.replace('https://', 'wss://').replace('http://', 'ws://');
    }
  })();
  const connectUrl = `${wsBase}/kortix/pty/${encodeURIComponent(ptyId)}/connect`;
  const params = new URLSearchParams();
  // Browser WebSocket API doesn't support custom headers, so inject the auth
  // token as a query param for the daemon (via the backend proxy) to check.
  const token = await getAuthToken();
  if (token) params.set('token', token);
  if (opts?.wake) params.set('wake', '1');
  const query = params.toString();
  if (!query) return connectUrl;
  return `${connectUrl}${connectUrl.includes('?') ? '&' : '?'}${query}`;
}

// ── Attach-side rules, shared by every host that owns a PTY socket ─────────
//
// Both of these ran on raw bytes and raw close frames in three places at once —
// `apps/web/src/features/session/pty-connection.ts`,
// `apps/cli/src/commands/sessions-shell.ts`, and
// `apps/tui/src/features/terminal/pty-session.ts` — because the SDK owned the
// REST half of the terminal and none of the socket half. Three copies of a
// close classifier is three chances to reconnect forever against a PTY id the
// daemon has forgotten.

/**
 * What a PTY socket close means for the owner of the attach.
 *
 * - `ended` — the shell exited. Show it and stop.
 * - `reconnect` — transport loss. The same PTY id is still valid; dial again.
 * - `replace` — the daemon no longer owns this PTY id. Reconnecting can never
 *   succeed; mint a new terminal.
 */
export type PtyCloseAction = 'ended' | 'reconnect' | 'replace';

/**
 * Classify a PTY socket close.
 *
 * The close CODE alone cannot answer this. An intermediary normalizes the code
 * to 1000 on a failed upstream — the historical behaviour behind the
 * user-visible "terminal died and never came back" — so the reason string and
 * the "did an error event fire" flag carry the truth, and a code that is not
 * 1000 only ever adds to it.
 *
 * Order matters: a forgotten PTY id outranks everything, because no amount of
 * reconnecting brings it back.
 */
export function classifyPtyClose(input: {
  code: number;
  reason: string;
  hadError: boolean;
}): PtyCloseAction {
  const reason = input.reason.trim().toLowerCase();

  // The daemon registry is intentionally process-local. A runtime restart, an
  // old persisted tab, or a create/attach race can leave a client holding an
  // id that can never succeed by reconnecting. The owner must mint a new PTY.
  if (reason.includes('pty not found')) return 'replace';

  // A clean shell exit is terminal. Everything that indicates transport loss
  // stays reconnectable even when the code has been normalized to 1000.
  if (reason.includes('pty exited')) return 'ended';
  if (
    input.hadError ||
    reason.includes('idle timeout') ||
    reason.includes('upstream error') ||
    input.code !== 1000
  ) {
    return 'reconnect';
  }

  return 'ended';
}

const ESC = '\x1b';
const BEL = '\x07';
const NUL = '\x00';
/** String Terminator: BEL, or ESC followed by a backslash. */
const ST = `(?:${BEL}|${ESC}\\\\)`;

/**
 * Shell-integration noise that no VT emulator is meant to render literally.
 *
 * The sandbox daemon's shell hooks emit OSC 697 plus a BARE `{"cursor":N}` JSON
 * payload — and the bare payload is not an escape sequence, so an emulator
 * prints it. The rest are capability-query REPLIES (DA, DECRQM, OSC colour)
 * echoed back at an idle prompt.
 *
 * Built with `new RegExp` rather than literals so the control bytes stay named
 * constants — a literal ESC inside a regex is unreadable.
 */
const PTY_NOISE: readonly RegExp[] = [
  new RegExp(`${ESC}\\]697;[^${BEL}${ESC}]*${ST}`, 'g'),
  new RegExp(`${NUL}?\\{"cursor":\\d+\\}`, 'g'),
  new RegExp(`${ESC}\\][0-9]+;rgb:[0-9a-fA-F/]+${ST}`, 'g'),
  new RegExp(`${ESC}\\]4;[0-9]+;rgb:[0-9a-fA-F/]+${ST}`, 'g'),
  new RegExp(`${ESC}\\[\\??[0-9;]*\\$y`, 'g'),
  new RegExp(`${ESC}\\[\\d+;\\d+R`, 'g'),
  new RegExp(`${ESC}\\[\\?[0-9;]*c`, 'g'),
];

/**
 * Strip shell-integration noise from one chunk of PTY output.
 *
 * Deliberately narrow: it runs on every byte of the user's live shell, so
 * over-stripping is worse than the noise it removes. Colour, cursor motion,
 * and clear-screen sequences pass through untouched.
 */
export function sanitizePtyChunk(chunk: string): string {
  let text = chunk;
  for (const pattern of PTY_NOISE) text = text.replace(pattern, '');
  return text;
}

/** Grouped namespace for ergonomic use (also available as named exports). */
export const kortixPty = {
  list: listKortixPty,
  create: createKortixPty,
  update: updateKortixPty,
  remove: removeKortixPty,
  webSocketUrl: getKortixPtyWebSocketUrl,
};
