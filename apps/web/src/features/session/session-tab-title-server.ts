import 'server-only';

import { createScopedKortix } from '@kortix/sdk/server';

import { sessionTabTitle, sessionTabTitleFromSession } from './session-tab-title';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { createClient } from '@/lib/supabase/server';

/**
 * Resolve the session tab title on the SERVER, for the route's
 * `generateMetadata`.
 *
 * This is the only durable owner of `document.title` on the session route.
 * A client-side write cannot hold: React re-asserts the metadata-owned
 * `<title>` when it commits, which lands AFTER client effects have run and
 * silently restores the root default (measured: client write at 306ms,
 * overwritten at 324ms). See `session-tab-title-sync.tsx` for the one narrow
 * case a client write is still correct.
 *
 * Everything here soft-fails to the "unavailable" title. `generateMetadata`
 * throwing would fail the whole route render, and a wrong tab title is never
 * worth a broken page.
 */

/**
 * How long the tab is allowed to wait on the API before falling back.
 *
 * Streaming metadata means the tab has NO title until this resolves (Next
 * appends the tag once `generateMetadata` returns — see the framework's
 * generate-metadata.md, "Streaming metadata"). The single-session endpoint
 * measures ~7ms locally, so this budget is a backstop against a stalled API,
 * not an expected cost.
 */
const TITLE_BUDGET_MS = 1_500;

async function withBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveSessionTabTitle(
  workspaceId: string,
  sessionId: string,
): Promise<string> {
  const unavailable = sessionTabTitle(null);
  try {
    const supabase = await createClient();
    const {
      data: { session: auth },
    } = await supabase.auth.getSession();
    const accessToken = auth?.access_token;
    // Signed out: the route itself redirects to /auth, so there is no session
    // to name. Do not guess.
    if (!accessToken) return unavailable;

    const backendUrl = getServerPublicEnv().BACKEND_URL;
    if (!backendUrl) return unavailable;

    // Scoped, never the process-global client: two users' metadata requests can
    // be in flight at once, and a global token would let one adopt the other's
    // identity. See packages/sdk/src/node/server.ts.
    const kortix = createScopedKortix({ backendUrl, getToken: async () => accessToken });

    const session = await withBudget(
      // `showErrors: false` — a 404 here is a normal outcome (deleted session,
      // wrong project), not something to surface as a toast on the server.
      kortix.session(workspaceId, sessionId).get({ showErrors: false }),
      TITLE_BUDGET_MS,
    );
    if (!session) return unavailable;

    return sessionTabTitleFromSession(session);
  } catch {
    return unavailable;
  }
}
