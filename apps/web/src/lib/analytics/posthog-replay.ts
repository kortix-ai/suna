/**
 * Which routes session replay may record.
 *
 * **Product decision, 2026-09-07: record every route.** The list below is
 * empty, so replay follows consent alone. It previously blocked `/projects/`,
 * `/share/` and `/admin`; recording those was chosen deliberately, with the
 * masking below as the protection.
 *
 * What keeps that safe: the recorder runs with `maskAllInputs: true` and
 * `maskTextSelector: '*'` (see `instrumentation-client.ts`), so a replay shows
 * layout, clicks, rage clicks and where someone dropped off — never prompt
 * text, code, file contents or another customer's data. Canvas is not recorded.
 *
 * What it costs: the workspace streams tokens into the DOM, so the recorder
 * does the most work there. Sampling and minimum duration live in the PostHog
 * project settings, tunable without a deploy — turn sampling down before
 * turning masking off.
 *
 * To re-block a surface, add its path prefix here; the machinery is unchanged
 * and `posthog-identify.tsx` stops the recorder on entry to it.
 */
export const REPLAY_BLOCKED_PREFIXES: readonly string[] = [];

export function replayAllowedForPath(pathname: string | null | undefined): boolean {
  if (!pathname || !pathname.startsWith('/')) return false;
  return !REPLAY_BLOCKED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
