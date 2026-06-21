'use client';

/**
 * Warm-pool presence — DISABLED.
 *
 * This used to heartbeat `/projects/:id/presence` every 45s while a project tab
 * was open, to keep a pre-warmed pool spare ready. The warm pool is off (and has
 * been by default), so the heartbeat did nothing server-side except generate a
 * steady stream of requests (one tab ≈ a beat every ~45s) that muddied activity
 * signals. Idle sandbox lifecycle is now owned by the provider-agnostic reaper
 * keyed off real turns (apps/api/src/projects/sandbox-reaper.ts), so tab-open
 * presence is no longer needed to keep anything warm.
 *
 * Kept as a no-op (stable import) so callers don't churn. If the warm pool is
 * ever re-enabled, restore the heartbeat here (and the now-unused
 * /presence + /presence/leave routes in apps/api/.../routes/r8.ts).
 */
export function useProjectPresence(_projectId: string | null | undefined): void {
  // intentionally no-op — see module doc.
}
