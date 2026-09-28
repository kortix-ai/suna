/**
 * May a session open on a runtime the daemon has PINNED?
 *
 * `classifyDaemonHealth` returns `blocked` on one flag — `runtime.pinned ===
 * true` — latched by the daemon's own supervisor after it tried an update,
 * failed, and rolled back. Never looping a repair on that is correct: another
 * attempt relaunches straight into the same rollback.
 *
 * "Do not REPAIR it automatically" and "refuse the SESSION" were the same
 * statement, and the second does not follow from the first. Measured on dev
 * 2026-09-28, a pinned box reported:
 *
 *   daemon ok · opencode ok · runtimeReady true · uptime 14917s
 *   components: cli=current, skills=current, agent=skipped, opencode=current
 *   reasons:    { agent: "updates pinned after a rollback" }
 *
 * Three of four components current and the box demonstrably serving — yet the
 * open answered `stage: 'failed', retriable: false`, so nobody could use that
 * session again and no retry could ever change it. That trades a GUARANTEED
 * total outage against a POSSIBLE degradation, and it is a boot-time one-shot
 * decision hardening forever — the failure shape the learnings ledger names.
 *
 * The operator signal is not lost by serving: `bootstrapLegacyRuntime` still
 * stamps the `blocked` classification into the sandbox's metadata, the reaper
 * still reads it, and the open logs a warning every time.
 */
import type { RuntimeClassification } from './legacy-runtime-bootstrap';

/**
 * PURE. True when a pinned runtime can still answer a prompt, so the open
 * should proceed instead of refusing the session.
 *
 * `opencode === 'ok'` is the whole distinction: it is the daemon's own report
 * that OpenCode is up and serving. A pinned box whose OpenCode is starting,
 * failed or absent genuinely cannot run a turn, and that one keeps failing.
 */
export function pinnedRuntimeMayServe(
  classification: Pick<RuntimeClassification, 'opencode'> | null | undefined,
): boolean {
  return classification?.opencode === 'ok';
}
