// Total wall-clock budget for the preview proxy's auto-wake retry loop. Must
// stay under the AWS ALB's 60s idle timeout: when every attempt hangs (a cold or
// errored sandbox whose Daytona upstream never answers) the proxy has to return
// its own friendly portUnreachable page BEFORE the load balancer severs the idle
// connection — otherwise the browser gets the LB/CDN's bare 502 (Cloudflare's
// branded error page) instead. 50s leaves ~10s of headroom.
export const PROXY_RETRY_BUDGET_MS = 50_000;
export const PROXY_ATTEMPT_TIMEOUT_MS = 15_000;

// Delays between the proxy's retry attempts. Short early delays so a transient
// post-restore RX stall (the daemon briefly unreachable ~1s) clears on the next
// attempt instead of stretching to seconds; the old [2000,5000,8000] turned a
// ~1s stall into multi-second session-list lag (2026-06-14). Later delays stay
// progressive for a genuinely cold-booting port. The last attempt ends inside
// the budget and one delay can follow it, so the budget, the attempt floor and
// the longest delay together must stay under the ALB idle cut.
export const PROXY_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

// OpenCode's synchronous send-message endpoint: the daemon holds the response
// open until the ENTIRE reasoning + tool-call turn finishes, then emits headers
// + body together — there is no early flush. (`prompt_async` is the sibling
// endpoint that returns immediately and streams progress over the
// `/global/event` SSE channel instead; that's the path the web UI uses
// precisely to avoid ever blocking on a turn's full duration.) A caller that
// blocks on this endpoint directly is structurally exposed to the same
// interval as a multipart upload, just mirrored: uploads can't emit headers
// until the client finishes WRITING the body, this can't emit headers until
// the server finishes COMPUTING it.
//
// `/command` blocks in exactly the same way and for the same reason — a `/`
// slash-command runs a full agent turn before the response is emitted — and it
// was missing from this matcher until 2026-08-11. The consequence was not a
// slow request but a DUPLICATED one: a command got the generic 15s connect cap,
// the abort read as a stalled connection, and the retry loop re-POSTed the same
// non-idempotent body. One prod session recorded one `/webapp` submit as four
// identical user messages, 11.0s / 11.8s / 13.7s apart.
export function isLongTurnCompletionRequest(request: { method: string; path: string }): boolean {
  return (
    request.method.toUpperCase() === 'POST' &&
    /^\/session\/[^/]+\/(?:message|command|summarize)(?:$|[/?#])/.test(request.path)
  );
}

export function isUploadRequest(request: { method: string; path: string }): boolean {
  return request.method.toUpperCase() === 'POST' && /^\/file\/upload(?:$|[/?#])/.test(request.path);
}

/**
 * One import attempt. The daemon answers `POST /file/import` only after the
 * download, fsync and rename, bounded by its own 120 s `IMPORT_TIMEOUT_MS`
 * (kortix-sandbox-agent-server `routes/files.ts`). This is longer, so the daemon
 * always answers or aborts before the proxy gives up. The API calls this route
 * itself during delivery; no browser waits on it behind the load balancer.
 */
export const PROXY_IMPORT_ATTEMPT_TIMEOUT_MS = 130_000;

/**
 * Only the daemon (:8000) serves `/file/import`. The same path on any other port
 * is the user's own server: it keeps the generic attempt timeout, the retry
 * budget and 5xx retries. `port` is the EFFECTIVE upstream port (Platinum
 * reroutes 4096 → 8000); without it the request is not an import.
 */
export function isFileImportRequest(request: { method: string; path: string; port?: number }): boolean {
  return (
    request.port === 8000 &&
    request.method.toUpperCase() === 'POST' &&
    /^\/file\/import(?:$|[/?#])/.test(request.path)
  );
}

// Per-attempt upstream fetch timeout, shrunk to whatever budget remains so the
// retry loop can never run past PROXY_RETRY_BUDGET_MS even if an attempt hangs.
export function proxyAttemptTimeoutMs(
  budgetRemainingMs: number,
  request?: { method: string; path: string; port?: number },
): number {
  // Upload handlers cannot return response headers until the multipart body has
  // been received and written. Treating that whole interval as a connection
  // stall aborts every sufficiently large upload at 15s, then retries the same
  // body until the outer 50s budget is exhausted. Give an upload the remaining
  // request budget; the outer budget still keeps us below the ALB idle timeout.
  //
  // A blocking session-message turn gets the exact same treatment and for the
  // exact same reason: capping it at the generic 15s connect window aborts a
  // perfectly healthy, still-reasoning turn, then the retry loop resubmits the
  // SAME (non-idempotent — it re-sends the user's message) request against
  // whatever budget is left, repeatedly, until the budget runs out — turning
  // an ordinary 20-40s turn into a manufactured 502 well before either the
  // outer budget or the ALB's idle timeout actually required one.
  if (request && isFileImportRequest(request)) return PROXY_IMPORT_ATTEMPT_TIMEOUT_MS;
  if (request && (isUploadRequest(request) || isLongTurnCompletionRequest(request))) {
    return Math.max(1_000, budgetRemainingMs - 500);
  }
  return Math.max(1_000, Math.min(PROXY_ATTEMPT_TIMEOUT_MS, budgetRemainingMs));
}
