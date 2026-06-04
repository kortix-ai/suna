/**
 * Kortix runtime feature gating.
 *
 * The Kortix OpenCode runtime ships a set of built-in features (memory, web
 * tools, terminal, …). Each is on by default but can be turned off — as a
 * project default in `kortix.toml` `[runtime]`, or enforced per-session via
 * the session-create API. The platform resolves the effective state and
 * injects it into the sandbox as env vars; the daemon forwards them to the
 * OpenCode runtime, and the built-in tools self-gate on them here.
 *
 * Env contract (set by the platform, forwarded by the daemon):
 *   KORTIX_RUNTIME_DISABLE_ALL = "true"   → disable ALL Kortix built-ins
 *                                            (run as plain OpenCode)
 *   KORTIX_RUNTIME_<FEATURE>   = "off"     → disable just that feature
 *                                            (e.g. KORTIX_RUNTIME_MEMORY=off)
 *
 * A feature is ON unless explicitly turned off, so a sandbox with no runtime
 * env vars behaves exactly as before (full Kortix defaults).
 */

const FALSEY = new Set(["off", "false", "0", "no", "disabled"]);

/** True when the whole Kortix runtime is disabled (pure-OpenCode mode). */
export function allDisabled(): boolean {
  return (process.env.KORTIX_RUNTIME_DISABLE_ALL || "").toLowerCase() === "true";
}

/** True when a given built-in feature is disabled for this session. */
export function featureDisabled(feature: string): boolean {
  if (allDisabled()) return true;
  const v = (process.env[`KORTIX_RUNTIME_${feature.toUpperCase()}`] || "").toLowerCase();
  return FALSEY.has(v);
}

/**
 * A terminal tool result returned when a feature is off. It's a normal string
 * result (not a thrown error) so the model reads it and moves on instead of
 * retrying a failing tool.
 */
export function disabledResult(feature: string, tool: string): string {
  return (
    `The \`${tool}\` tool is disabled for this session by Kortix runtime policy ` +
    `(feature "${feature}" is off). Do not retry — proceed without it.`
  );
}
