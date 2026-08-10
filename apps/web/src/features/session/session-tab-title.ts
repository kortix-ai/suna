import type { WorkspaceSession } from '@kortix/sdk';

import { getSessionDisplayTitle } from '@/features/workspace/workspace-sidebar/workspace-session-list-helpers';
import { siteMetadata } from '@/lib/site-metadata';

/**
 * The browser tab title for one session, as ONE pure function.
 *
 * Why a pure function rather than a hook: the title is produced in two
 * runtimes — Node, inside the route's `generateMetadata`, and the browser, when
 * the session is renamed after load. Both call this, so both emit a
 * byte-identical string and the hand-off from server metadata to the client
 * updater is invisible instead of a flash.
 *
 * Deliberately NOT `sessionDisplayLabel` (components/workspaces/session-label.ts):
 * that helper's fallback chain ends at `session.session_id.slice(0, 8)`, which
 * would paint a raw uuid fragment into the tab strip. A tab is read at a glance
 * out of the corner of an eye; "3f9a1c2b" is noise there, "New session" is
 * information.
 */

/** Longest session name kept before it is elided, INCLUDING the ellipsis. */
export const SESSION_TAB_TITLE_MAX_NAME = 60;

/** Separator between the session name and the app name. */
const SEPARATOR = ' — ';

/**
 * Shown when the session could not be read at all (404, no auth, timeout).
 *
 * Distinct from an untitled session, which `getSessionDisplayTitle` already
 * names "New session" — "we could not read this" and "this has no name yet"
 * are different facts and must not share a label.
 */
const UNAVAILABLE = 'Session';

/** One line, no runs of whitespace — a tab cannot render a newline anyway. */
function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function elide(value: string): string {
  if (value.length <= SESSION_TAB_TITLE_MAX_NAME) return value;
  return `${value.slice(0, SESSION_TAB_TITLE_MAX_NAME - 1).trimEnd()}…`;
}

/**
 * `<session name> — Kortix`. An absent name means the session could not be
 * read, so it gets the explicit unavailable label: never an empty title, never
 * a raw id.
 */
export function sessionTabTitle(name: string | null | undefined): string {
  const clean = name ? flatten(name) : '';
  return `${elide(clean || UNAVAILABLE)}${SEPARATOR}${siteMetadata.name}`;
}

/**
 * `sessionTabTitle` for a session record, or the unavailable title if absent.
 *
 * The name comes from `getSessionDisplayTitle` — the SAME function the sidebar,
 * the session list, and the tab bar render — so a session reads identically in
 * the tab and in the app, including its "New session" placeholder. Deriving the
 * precedence a second time here is how the two would drift apart.
 */
export function sessionTabTitleFromSession(session: WorkspaceSession | null | undefined): string {
  if (!session) return sessionTabTitle(null);
  return sessionTabTitle(getSessionDisplayTitle(session));
}
