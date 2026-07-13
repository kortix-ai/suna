// Total wall-clock budget for the preview proxy's auto-wake retry loop. Must
// stay under the AWS ALB's 60s idle timeout: when every attempt hangs (a cold or
// errored sandbox whose Daytona upstream never answers) the proxy has to return
// its own friendly portUnreachable page BEFORE the load balancer severs the idle
// connection — otherwise the browser gets the LB/CDN's bare 502 (Cloudflare's
// branded error page) instead. 50s leaves ~10s of headroom.
export const PROXY_RETRY_BUDGET_MS = 50_000;
export const PROXY_ATTEMPT_TIMEOUT_MS = 15_000;

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
  if (
    request?.method.toUpperCase() === 'POST' &&
    /^\/file\/upload(?:$|[/?#])/.test(request.path)
  ) {
    return Math.max(1_000, budgetRemainingMs - 500);
  }
  return Math.max(1_000, Math.min(PROXY_ATTEMPT_TIMEOUT_MS, budgetRemainingMs));
}
