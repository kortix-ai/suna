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
export function proxyAttemptTimeoutMs(budgetRemainingMs: number): number {
  return Math.max(1_000, Math.min(PROXY_ATTEMPT_TIMEOUT_MS, budgetRemainingMs));
}
