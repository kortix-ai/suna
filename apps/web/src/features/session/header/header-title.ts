import {
  UNTITLED_SESSION_LABEL,
  getSessionDisplayTitle,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
import type { ProjectSession } from '@kortix/sdk';

/**
 * The one name in the session header.
 *
 * A session has TWO names, and only one of them is the session's.
 *
 *  • Kortix's name — what the sidebar shows, what a rename edits, and what the
 *    server writes 3–15s after the first prompt. Authoritative.
 *  • opencode's `session.title` — the summary the agent writes for ITSELF
 *    ("Greeting"), inside the sandbox, and rewrites again as the conversation
 *    moves. Never authoritative, and not stable.
 *
 * The header already preferred the first. The bug was the fallback: it dropped
 * to the caller's prop whenever the Kortix row was not in the cache YET, and on
 * this route that prop is opencode's title. So a header with a loading session
 * list painted opencode's name, then swapped to opencode's NEXT name, then
 * finally to the Kortix one — the title visibly changing two or three times on
 * a session that was only ever called one thing.
 *
 * The crossfade made it worse rather than causing it: the boot shell and the
 * real chat each render a header, they are both on screen for the fade, and
 * they pass DIFFERENT fallbacks ("New session" vs opencode's title). Any frame
 * where the row was missing showed the two disagreeing at once.
 *
 * So the fallback is now scoped. On `/projects/:id/sessions/:id` the Kortix row
 * is the only name that may render, and until it arrives the header says what
 * the sidebar says for the same session — `UNTITLED_SESSION_LABEL`. The prop is
 * kept for the surfaces that genuinely have no project session to read (the
 * share viewer), which is what it was added for.
 *
 * The result is one source, one placeholder, and at most one visible change:
 * the real name landing. Both headers compute it identically, so the fade
 * cannot show a disagreement.
 */
export function resolveSessionHeaderTitle(input: {
  /** The Kortix row for this session, or null while the list is loading. */
  projectSession: ProjectSession | null;
  /** The route is `/projects/:id/sessions/:id`, so a Kortix row is coming. */
  isProjectSession: boolean;
  /** The caller's own title. Only reachable off the project-session route. */
  fallbackTitle: string;
}): string {
  if (input.projectSession) return getSessionDisplayTitle(input.projectSession);
  return input.isProjectSession ? UNTITLED_SESSION_LABEL : input.fallbackTitle;
}
