/**
 * One read of a Kortix session row, riding the session-open bundle on the
 * open path.
 *
 * The bundle's `session` leg is the row `GET .../sessions/:id` serves (the API
 * builds both with `serializeSession`; the bundle omits `owner_email`, which no
 * single-row reader renders). On a cold open the session page needs the row
 * for the OpenCode root id before it can paint the transcript, so a separate
 * row request sat on that path beside the bundle that already carried it.
 *
 * Same claim rule as `/turn` and `/prompts`: only the FIRST read — no row
 * cached yet — may be answered by the bundle. Anything after that is a read
 * issued because something changed, and it asks the endpoint.
 *
 * Internal: not exported from any public entry point.
 */

import { getProjectSession, type ProjectSession } from '../rest/projects-client/sessions';
import { claimOpenBundle } from './open-bundle';

export async function readProjectSessionRow(
  projectId: string,
  sessionId: string,
  options: {
    bundle: boolean;
    /** The row endpoint. Injected so a host-level test double of the REST
     *  barrel reaches this read too. */
    fetchRow?: typeof getProjectSession;
  },
): Promise<ProjectSession> {
  const claimed = options.bundle ? claimOpenBundle(projectId, sessionId) : null;
  if (claimed) {
    const bundle = await claimed;
    if (bundle?.session) return bundle.session;
  }
  const fetchRow = options.fetchRow ?? getProjectSession;
  return fetchRow(projectId, sessionId, { showErrors: false });
}
