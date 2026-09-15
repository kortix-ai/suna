/**
 * Which sessions get their transcript re-read after an SSE gap.
 *
 * The old rule was "the ones whose status slot says busy", and it could not
 * work: the status slot is filled BY the stream, so a gap long enough to lose
 * message frames is long enough to lose the status frame that would have
 * marked the session busy. The sessions most likely to be missing content were
 * therefore the ones most likely to be skipped — and a session that went
 * silently idle during the gap kept a truncated final answer with nothing left
 * to correct it.
 *
 * A gap means: for some interval, this tab is not sure what the runtime said.
 * The honest response is to re-read every transcript this tab is holding. That
 * is bounded — a tab holds one open session plus a handful of recently viewed
 * ones — and each read is a single tail page.
 */
export function sessionsNeedingRehydrate(loadedSessionIds: string[]): string[] {
  return [...new Set(loadedSessionIds)];
}
