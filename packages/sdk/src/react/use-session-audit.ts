'use client';

/**
 * The bundle-aware read behind a session's pending-approvals poll.
 *
 * Mirrors `readSessionPromptsInbox` (`use-session-prompts.ts`) and
 * `useSessionWorking`'s turn read (`use-session-working.ts`): the session-open
 * bundle answers the FIRST read of an open burst, and every read after that —
 * a tab that already holds rows — asks the endpoint directly. See
 * `readSessionPromptsInbox`'s doc comment for why a read that already holds
 * rows must never answer from the bundle: the same staleness trap applies
 * here (a resolved approval sitting in the bundle's 5s share window would
 * un-resolve on screen for a poll that lands inside it).
 *
 * `apps/web`'s `useSessionAudit` (`features/session/session-audit-shared.tsx`)
 * is this function's only host-side caller. It stays app-local because it is
 * shared by two UI surfaces (the audit panel and the header approvals nudge)
 * with app-specific toast/error wiring that does not belong in the SDK — but
 * the READ itself, per the SDK's "logic lives in the SDK" rule, is here.
 */

import { claimOpenBundle, openBundleAudit } from '../core/session/open-bundle';
import { type SessionAudit, getSessionAudit } from '../core/rest/projects-client/sessions';

const EMPTY_AUDIT: SessionAudit = {
  session_id: '',
  agent: null,
  audit_access: false,
  count: 0,
  actions: [],
};

/**
 * Read a session's pending-approvals projection, claiming the session-open
 * bundle first when this is the FIRST read (`cached === undefined`).
 *
 * Always requests `includeEvents: false` — the approval-projection half only,
 * matching what every open session tab already polls. A consumer that needs
 * the historical timeline uses `getSessionAudit` directly, unchanged.
 */
export async function readSessionAudit(
  projectId: string | undefined,
  sessionId: string | undefined,
  cached: SessionAudit | undefined,
  limit: number,
  options?: { showErrors?: boolean },
): Promise<SessionAudit> {
  if (!projectId || !sessionId) return cached ?? EMPTY_AUDIT;

  const claimed = cached === undefined ? claimOpenBundle(projectId, sessionId) : null;
  if (claimed) {
    const bundle = await claimed;
    const bundled = bundle ? openBundleAudit(bundle) : null;
    if (bundled) return bundled;
  }

  return getSessionAudit(projectId, sessionId, limit, {
    includeEvents: false,
    showErrors: options?.showErrors,
  });
}
