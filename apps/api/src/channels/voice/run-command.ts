/**
 * `run_command` — unrestricted shell exec in the voice call's session sandbox.
 *
 * This is deliberately UNRESTRICTED (no allowlist, no cwd jail) at the user's
 * explicit request. That makes the voice agent a second writer on the same
 * sandbox the Kortix session's own agent is working in — no audit/policy layer
 * wraps it (the only one that exists, executor/gateway.ts, is scoped to
 * connector actions and doesn't apply to raw sandbox shell access). Treat this
 * the same as giving the sandbox's owner a second terminal.
 *
 * There is no one-shot "run a command, get stdout/exit code back" primitive on
 * the sandbox daemon — only `/kortix/pty` (spawn a PTY, attach a WebSocket to
 * watch it live; see the exec-path notes this module was written against).
 * This function builds that primitive on top: POST to spawn, then attach a
 * WS just long enough to collect output and an exit code. Output is whatever
 * the PTY produced — stdout and stderr are NOT separable, because a PTY
 * merges them by nature; `result.stderr` mirrors `result.stdout` rather than
 * being empty for that reason (apps/voice-agent's `run_command` tool only
 * surfaces `stderr` on a non-zero exit, and a real PTY-merged command's only
 * output IS in that stream — leaving `stderr` empty would silently drop it).
 *
 * One caller: mcp.ts's `run_command` tool, invoked by apps/voice-agent's
 * `run_command` tool (kortix-client.ts) over the voice MCP. That worker call
 * additionally times out CLIENT-side at 12s — this file's OVERALL_TIMEOUT_MS
 * is set safely under that so a slow provider call here degrades to
 * `timedOut: true` well before the worker's own timeout would otherwise turn
 * the whole request into a bare network error instead of a readable result.
 */
import { eq } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import {
  buildSandboxUpstreamHeaders,
  loadSandbox,
  resolveSandboxIngress,
  type SandboxRecord,
} from '../../sandbox-proxy/backend';
import { KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';

const SPAWN_TIMEOUT_MS = 3_000;
const CAPTURE_TIMEOUT_MS = 6_000;
/** Hard ceiling on the whole operation — see the file header's two-callers note. */
const OVERALL_TIMEOUT_MS = 9_000;
/**
 * The daemon's `/kortix/pty` has no REST way to fetch a finished pty's output
 * — only a live WS attach, which replays scrollback ONLY when the pty is still
 * 'running' at attach time (see routes/pty.ts's `attachOrCreate`). A fast
 * command (`echo hi`) can exit before our POST's response even comes back, so
 * we pad the spawned process with a trailing sleep purely to keep it 'running'
 * long enough for the WS attach below to land and replay everything the real
 * command already produced.
 */
const CAPTURE_TAIL_SECONDS = 1;

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

async function loadSandboxForSession(
  sessionId: string,
): Promise<{ record: SandboxRecord; userId: string | null } | null> {
  const [row] = await db
    .select({ externalId: sessionSandboxes.externalId, status: sessionSandboxes.status })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!row?.externalId || (row.status !== 'active' && row.status !== 'provisioning')) return null;

  const record = await loadSandbox(row.externalId);
  if (!record) return null;

  const [session] = await db
    .select({ createdBy: projectSessions.createdBy })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  return { record, userId: session?.createdBy ?? null };
}

function parseExitCode(reason: string | undefined): number | null {
  // The daemon closes with reason `pty exited${code === null ? '' : ` (${code})`}`.
  const m = reason?.match(/\((-?\d+)\)/);
  return m ? parseInt(m[1]!, 10) : null;
}

function captureOverWs(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let ws: WebSocket | null = null;

    const done = (exitCode: number | null, timedOut: boolean) =>
      finish({ stdout: output, stderr: output, exitCode, timedOut });

    const timer = setTimeout(() => done(null, true), timeoutMs);

    function finish(result: RunCommandResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {}
      resolve(result);
    }

    try {
      // Bun extends the WebSocket constructor with a `headers` option — same
      // mechanism ws-proxy.ts uses to forward the signed user-context, since
      // this is a server-side client and not subject to the browser
      // can't-set-headers-on-a-socket restriction that the query-param fallback
      // below exists for.
      ws = new WebSocket(url, { headers } as any);
    } catch {
      done(null, false);
      return;
    }

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') output += ev.data;
    };
    ws.onclose = (ev: CloseEvent) => done(parseExitCode(ev.reason), false);
    ws.onerror = () => done(null, false);
  });
}

async function execCommand(
  sessionId: string,
  command: string,
  cwd?: string,
): Promise<RunCommandResult> {
  const resolved = await loadSandboxForSession(sessionId);
  if (!resolved) throw new Error('sandbox not ready');
  const { record, userId } = resolved;

  const httpIngress = await resolveSandboxIngress(record, { port: 8000, transport: 'http' });
  const httpHeaders = await buildSandboxUpstreamHeaders({
    sandboxId: record.sandboxId,
    userId: userId ?? '',
    serviceKey: record.serviceKey,
    providerHeaders: httpIngress.headers,
  });

  const wrapped = `${command}; __kortix_exit=$?; sleep ${CAPTURE_TAIL_SECONDS}; exit $__kortix_exit`;

  const createRes = await fetch(`${httpIngress.url.replace(/\/$/, '')}/kortix/pty`, {
    method: 'POST',
    headers: { ...httpHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'bash',
      args: ['-lc', wrapped],
      ...(cwd ? { cwd } : {}),
      title: 'voice run_command',
    }),
    signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '');
    throw new Error(`pty create failed: ${createRes.status}${body ? ` ${body.slice(0, 300)}` : ''}`);
  }
  const created = (await createRes.json()) as { id: string };
  const ptyPath = `/kortix/pty/${created.id}/connect`;

  const wsIngress = await resolveSandboxIngress(record, { port: 8000, path: ptyPath, transport: 'websocket' });
  const wsHeaders = await buildSandboxUpstreamHeaders({
    sandboxId: record.sandboxId,
    userId: userId ?? '',
    serviceKey: record.serviceKey,
    providerHeaders: wsIngress.headers,
  });

  const wsUrl = new URL(wsIngress.url.replace(/\/$/, '') + ptyPath);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  // Belt-and-suspenders for providers whose edge strips custom headers (see
  // ResolvedSandboxIngress.websocket in platform/providers/index.ts) —
  // identical to how preview.ts's resolvePreviewWsUpstream handles it.
  if (wsIngress.websocket?.userContextQueryParam) {
    const signed = wsHeaders[KORTIX_USER_CONTEXT_HEADER];
    if (signed) wsUrl.searchParams.set(wsIngress.websocket.userContextQueryParam, signed);
  }

  const result = await captureOverWs(wsUrl.toString(), wsHeaders, CAPTURE_TIMEOUT_MS);

  // Best-effort cleanup — never let a slow/failed DELETE hold up the tool
  // response, which by this point already has everything it needs.
  void fetch(`${httpIngress.url.replace(/\/$/, '')}/kortix/pty/${created.id}`, {
    method: 'DELETE',
    headers: httpHeaders,
    signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
  }).catch(() => {});

  return result;
}

/**
 * `execCommand` bounded by OVERALL_TIMEOUT_MS regardless of how the time
 * splits across the steps inside it (ingress resolution alone can, in the
 * worst case, take much longer than SPAWN_TIMEOUT_MS — see
 * platform/providers/daytona.ts's own 20s default). This is the real safety
 * net; the per-step timeouts inside execCommand just keep a single slow step
 * from eating the whole budget by itself.
 */
export async function runCommandInSandbox(
  sessionId: string,
  command: string,
  cwd?: string,
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    }, OVERALL_TIMEOUT_MS);

    execCommand(sessionId, command, cwd).then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        if (settled) return; // the overall timeout already won; drop the late error
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
