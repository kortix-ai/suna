/**
 * Which routes session replay may record.
 *
 * Replay is FAIL-CLOSED. `instrumentation-client.ts` initialises PostHog with
 * `disable_session_recording: true`, so the recorder never starts on its own,
 * and `posthog-identify.tsx` calls `startSessionRecording()` only while the
 * current route is allowed here. Nothing is captured in the frames between a
 * blocked route mounting and the first effect running, which is exactly the
 * leak a "record everything, then stop" design has.
 *
 * Blocked, and why:
 *  - `/projects/…`  the workspace — prompts, transcripts, code, files, diffs and
 *                   the terminal. Also the surface with the highest DOM mutation
 *                   rate, where the recorder costs the most CPU.
 *  - `/share/…`     public session shares render the same transcripts.
 *  - `/admin…`      the operator console shows other customers' accounts.
 *
 * Allowed is the funnel worth watching: marketing, `/auth`, `/dashboard`, the
 * `/projects` list, onboarding, pricing and checkout. Even there the recorder
 * masks every input and every text node (`session_recording` config), so a
 * replay shows layout, clicks, rage clicks and the drop-off point — never
 * content.
 */
export const REPLAY_BLOCKED_PREFIXES = ['/projects/', '/share/', '/admin'] as const;

export function replayAllowedForPath(pathname: string | null | undefined): boolean {
  if (!pathname || !pathname.startsWith('/')) return false;
  return !REPLAY_BLOCKED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
