// Total wall-clock budget for the preview proxy's auto-wake retry loop. Must
// stay under the AWS ALB's 60s idle timeout: when every attempt hangs (a cold or
// errored sandbox whose Daytona upstream never answers) the proxy has to return
// its own friendly portUnreachable page BEFORE the load balancer severs the idle
// connection — otherwise the browser gets the LB/CDN's bare 502 (Cloudflare's
// branded error page) instead. 50s leaves ~10s of headroom.
export const PROXY_RETRY_BUDGET_MS = 50_000;
export const PROXY_ATTEMPT_TIMEOUT_MS = 15_000;

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
export function isLongTurnCompletionRequest(request: { method: string; path: string }): boolean {
  return (
    request.method.toUpperCase() === 'POST' &&
    /^\/session\/[^/]+\/message(?:$|[/?#])/.test(request.path)
  );
}

function isUploadRequest(request: { method: string; path: string }): boolean {
  return request.method.toUpperCase() === 'POST' && /^\/file\/upload(?:$|[/?#])/.test(request.path);
}

// Per-attempt upstream fetch timeout, shrunk to whatever budget remains so the
// retry loop can never run past PROXY_RETRY_BUDGET_MS even if an attempt hangs.
export function proxyAttemptTimeoutMs(
  budgetRemainingMs: number,
  request?: { method: string; path: string },
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
  if (request && (isUploadRequest(request) || isLongTurnCompletionRequest(request))) {
    return Math.max(1_000, budgetRemainingMs - 500);
  }
  return Math.max(1_000, Math.min(PROXY_ATTEMPT_TIMEOUT_MS, budgetRemainingMs));
}
