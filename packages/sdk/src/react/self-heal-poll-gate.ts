import type { SandboxConnectionStatus } from '../browser/stores/sandbox-connection-store';

/**
 * Whether a reconnect self-heal poll may run at all.
 *
 * The permission/question self-heal polls exist for ONE case: a live SSE
 * stream dropped a `permission.asked` / `question.asked` frame while the
 * runtime stayed reachable. They are a backstop for a reachable runtime — not
 * a liveness probe.
 *
 * The bug this closes (prod, KRTX-269): while the poll was `enabled` and a tool
 * part still rendered as `running` (the part that was mid-flight when the box
 * parked never settles without another SSE frame), the two pollers kept hitting
 * the parked sandbox forever. A parked box answers every read from the session
 * row with `503 sandbox_not_ready` (`hop: control_plane`) and a GET can never
 * resume it — so each interval produced a 5xx that could never become a 200.
 * In a background tab the browser throttles `setInterval` to roughly once a
 * minute, which is why the fleet saw one `/permission` 5xx per minute per
 * parked session.
 *
 * A poll is pointless on anything but a connected, non-parked runtime:
 *   - `connecting` / `unreachable`: no runtime to answer it.
 *   - `parked`: the platform answered from the session row without dialling the
 *     box; the box resumes only on the next SEND, never on a GET.
 *
 * Pure so it is unit-tested without rendering the hook.
 */
export function shouldRunSelfHealPoll(input: {
  /** Host gate (`useSession`'s `enabled`). */
  enabled: boolean;
  /** A running/pending tool part that could be blocked on an ask. */
  hasCandidate: boolean;
  /** Pending asks already known for this session — nothing to self-heal. */
  pendingCount: number;
  sandboxStatus: SandboxConnectionStatus;
  /** The box is parked, not booting: see `sandbox-connection-store.parked`. */
  parked: boolean;
}): boolean {
  if (!input.enabled || !input.hasCandidate || input.pendingCount > 0) return false;
  return input.sandboxStatus === 'connected' && !input.parked;
}
