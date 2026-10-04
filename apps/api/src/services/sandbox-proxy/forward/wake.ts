import { BOOT_PHASE_HEADER, RUNTIME_NOT_READY_CODE } from '@kortix/api-contract/runtime-relay';
import { classifyPtyWebSocketPath } from '../../platform/providers/pty-ingress';
import { resumeStoppedSandboxByExternalId } from '../../sessions/open/shared';
import { loadSandbox, type SandboxRecord } from '../backend';
import { isBrowserNavigation, portUnreachableResponse } from '../preview-response';
import { carriesSessionData } from '../session-data-ports';
import type { PreviewProxyAccess } from './access';

// Bringing a stopped box up: when a proxied request may wake it, the wake
// itself, and how the daemon says it is still booting.

// opencode's HTTP/SSE + PTY server binds 127.0.0.1:4096 (loopback-only). Daytona
// (a container) reaches it directly; Platinum (a microVM) has its edge dial the
// guest's eth0 IP, so :4096 is unreachable → 502 ("upstream-unreachable"). This
// is what breaks `kortix sessions connect` / `opencode attach` on Platinum.
//
// The sandbox agent on :8000 (binds 0.0.0.0, reachable) already reverse-proxies
// every path to opencode's localhost:4096 in-box. So for Platinum we route
// opencode(4096) traffic through :8000 — the same bridge the /pty/ WebSocket
// already uses. The 8000-keyed guards below (session-visibility gate, /kortix/env
// block) key on the EFFECTIVE upstream port so rerouted opencode traffic is
// subject to the SAME protection as a direct :8000 request — the reroute changes
// reachability, never the auth/control surface.
/**
 * Should the data-path proxy WAKE a stopped box instead of 503ing it?
 *
 * Two cases, and the difference between them is the whole point:
 *
 *  - A real user mutating OpenCode session data. A POST/PUT/PATCH/DELETE is an
 *    explicit action. A GET/HEAD/OPTIONS can be transcript hydration, cache
 *    warming, polling, or a background reconnect and must never resume a box.
 *  - A real user LOADING A PREVIEW PAGE. `browserNavigation` is the load-bearing
 *    condition: a top-level document / iframe load is a human explicitly opening
 *    the app, which is the same class of intent as clicking into the session. An
 *    asset fetch, an XHR poll or a background stream reconnect is NOT, and must
 *    still 503 — passive resurrection is what produced 1,597 phantom-active
 *    compute rows. Without this branch a user whose dev server had been parked
 *    could never get it back through the preview at all, only by prompting the
 *    agent, which is the "preview ports cannot auto-resume" regression.
 *
 * Never for a request the SANDBOX authored (it holds a credential that resolves
 * to a perfectly valid principal), and never for a non-user (service/share)
 * caller. Pure + exported so the gate is unit-tested without provisioning a box.
 */
export function shouldAutoResumeStoppedSandbox(
  status: string,
  upstreamPort: number,
  accessKind: string,
  opts: {
    sandboxAuthored?: boolean;
    browserNavigation?: boolean;
    method?: string;
  } = {},
): boolean {
  if (status !== 'stopped' || accessKind !== 'principal') return false;
  if (opts.sandboxAuthored) return false;
  if (carriesSessionData(upstreamPort)) {
    const method = opts.method?.toUpperCase();
    return Boolean(method && !['GET', 'HEAD', 'OPTIONS'].includes(method));
  }
  return opts.browserNavigation === true && !carriesSessionData(upstreamPort);
}

/**
 * Should a WebSocket UPGRADE wake a stopped box?
 *
 * The HTTP data path wakes a parked box on explicit user intent
 * (`shouldAutoResumeStoppedSandbox`). The WebSocket path had no such branch at
 * all: it answered `503 sandbox not ready` and stopped there. A browser never
 * sees that status — a refused upgrade surfaces only as close code `1006` — so
 * the terminal reconnected against a parked box forever, and nothing in the
 * loop could ever wake it. Reloading the page did not help either: the panel's
 * `GET /kortix/pty` is a GET on a session-data port, which by policy also never
 * resumes. The terminal was therefore unrecoverable until the user prompted the
 * agent (a POST) or restarted the session.
 *
 * A terminal ATTACH is the same class of intent as a session mutation: a human
 * opened the panel or pressed a control. The client marks that attach with
 * `wake=1` and keeps the mark on its retries only until the attach opens. The
 * wake is asynchronous and the row stays `stopped` until the provider confirms
 * the box, so each marked dial during the wake is refused with 503 and the
 * client dials again. Once an attach has opened the client stops marking, so a
 * socket that drops because the box parked (the "passive resurrection" the
 * resume policy exists to prevent) still cannot wake it.
 *
 * Pure + exported so the gate is unit-tested without provisioning a box.
 */
export function shouldWakeStoppedSandboxForWsAttach(
  status: string,
  remainingPath: string,
  opts: { wakeRequested: boolean },
): boolean {
  if (status !== 'stopped') return false;
  if (!opts.wakeRequested) return false;
  return classifyPtyWebSocketPath(remainingPath) !== null;
}

/**
 * Claim the wake of a stopped box, then re-read its row. A failed resume is
 * logged under `logPrefix` and swallowed. Returns the fresh row, or `record`
 * when the re-read finds nothing.
 */
export async function resumeAndReloadSandbox(
  sandboxId: string,
  record: SandboxRecord,
  logPrefix: string,
): Promise<SandboxRecord> {
  const resumeExternalId = record.externalId;
  await resumeStoppedSandboxByExternalId(resumeExternalId).catch((err) => {
    console.warn(`${logPrefix} auto-resume failed for ${resumeExternalId}:`, err);
    return false;
  });
  const resumed = await loadSandbox(sandboxId);
  return resumed ?? record;
}

/**
 * A request for a box whose row is not `active`: wake it when the caller's
 * intent allows, then answer 503 unless the re-read row is active. Returns the
 * row to forward to, or the response to send instead.
 */
export async function wakeOrRefuseInactiveSandbox(input: {
  record: SandboxRecord;
  sandboxId: string;
  port: number;
  upstreamPort: number;
  access: PreviewProxyAccess;
  sandboxAuthored: boolean;
  method: string;
  incomingHeaders: Headers;
  origin: string;
}): Promise<{ record: SandboxRecord } | { response: Response }> {
  const { sandboxId, port, upstreamPort, access, sandboxAuthored, method, incomingHeaders, origin } = input;
  let record = input.record;
  // A stopped-but-resumable box wakes only on explicit user intent. Session
  // mutations and top-level preview navigation qualify. Transcript reads,
  // cache hydration, polling, and background reconnects return 503. The normal
  // session page calls `/start` before reading the runtime, so navigation still
  // resumes deterministically without making every authenticated GET wake-capable.
  if (
    shouldAutoResumeStoppedSandbox(record.status, upstreamPort, access.kind, {
      sandboxAuthored,
      browserNavigation: isBrowserNavigation(incomingHeaders),
      method,
    })
  ) {
    // Re-read. The resume only claims the wake: the row stays 'stopped' until
    // the provider confirms the box, so this request usually returns the 503
    // below and the client's retry forwards once the row is 'active'.
    record = await resumeAndReloadSandbox(sandboxId, record, '[sandbox-proxy]');
  }
  if (record.status !== 'active') {
    return {
      response: portUnreachableResponse({
        port,
        status: 503,
        origin,
        incomingHeaders,
        reason: `sandbox not ready (status: ${record.status})`,
        // We never dialled the box. This is our own row read, so it says
        // nothing about whether the runtime is reachable — a probe that counts
        // it as evidence of a dead box is counting our own answer.
        hop: 'control_plane',
        code: 'sandbox_not_ready',
        retry: true,
      }),
    };
  }
  return { record };
}

/**
 * The daemon's 503 while the session runtime cannot take a request: it names
 * its boot phase in `X-Kortix-Boot-Phase` and answers `code: runtime_not_ready`
 * (both harnesses).
 */
export function isDaemonRuntimeNotReady(headers: Headers, bodyText: string): boolean {
  if (headers.has(BOOT_PHASE_HEADER)) return true;
  try {
    if ((JSON.parse(bodyText) as { code?: unknown }).code === RUNTIME_NOT_READY_CODE) return true;
  } catch {
    // not JSON
  }
  // legacy: a daemon built before the code and the header sends only this
  // text (pi and OpenCode's boot steps, then OpenCode's process gate). Delete
  // once no box runs such a daemon.
  return /sandbox runtime not ready|opencode not ready/.test(bodyText);
}
