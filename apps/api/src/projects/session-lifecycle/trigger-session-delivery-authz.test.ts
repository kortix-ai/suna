/**
 * A queued prompt for a TRIGGER-CREATED session must survive the proxy's
 * session-visibility gate.
 *
 * Incident (local, 2026-08-31): every trigger run produced an empty transcript.
 * A trigger creates its session with `session_access_mode='private'`, so the
 * row is `visibility='private'` with `created_by` = the AUTOMATION ACTOR — not
 * the human. When the human then typed into that session, `deliverPrompt`
 * forwarded through the user-facing proxy, `canAccessSandboxSession` denied it,
 * and `prompt_async` threw `Not authorized to access this session` nine times
 * before the command dead-lettered as `delivery outcome: pending`.
 *
 * `isProjectSessionVisibleTo` HAS the override for exactly this case — a
 * project manager may open a session a trigger created. It is gated on
 * `boundCredentialSessionId === null` so that a session-bound SANDBOX token
 * cannot use it to reach sibling trigger sessions. `deliverPrompt` was passing
 * the TARGET session id there, so the override was unreachable from the one
 * path that needs it.
 *
 * Passing `null` is correct for this path and cannot widen access:
 *   - the sibling-narrowing verdict is unchanged (proved below), because the
 *     binding equalled the target session id, and
 *   - every row in this queue was already authorized at enqueue time by
 *     `POST /prompts` → `loadVisibleSession(..., callerKortixSessionId(c),
 *     callerKortixSessionId(c))`, which applies the real narrowing. There is no
 *     agent/sandbox-bound value in `SessionInvocationSource` at all.
 */

import { describe, expect, test } from 'bun:test';
import {
  isProjectSessionVisibleTo,
  isSessionTargetVisibleToCaller,
  isTriggerCreatedSessionMetadata,
} from '../../connectors/share';

// Verbatim from kortix.project_sessions for the stuck run ca470c15.
const TRIGGER_SESSION_METADATA = {
  name: 'Load the `monalisa-monday` skill and run the pipeline',
  source: 'trigger:cron',
  trigger_kind: 'git',
  trigger_slug: 'monday-plate',
  trigger_type: 'cron',
};
const SESSION_ID = 'ca470c15-d7e7-482a-9dac-7e457d0ed9a2';
/** `created_by` — the automation actor the trigger ran as. */
const AUTOMATION_ACTOR = 'ec96de50-1e2a-4a33-a5a1-bda7a81c082e';
/** The human who owns the account and typed into the session. */
const HUMAN = 'e512c414-f24e-4316-92cb-26a5f914038e';

const subject = { userId: HUMAN, groupIds: [] as string[] };

function visibleTo(boundCredentialSessionId: string | null, canManageProject = true): boolean {
  return isProjectSessionVisibleTo(
    'private',
    AUTOMATION_ACTOR,
    [],
    subject,
    {
      origin: 'schedule',
      sessionId: SESSION_ID,
      // A signed-in human always carries a Supabase LOGIN session id here.
      callerSessionId: 'supabase-login-session',
      boundCredentialSessionId,
    },
    { metadata: TRIGGER_SESSION_METADATA, canManageProject },
  );
}

describe('trigger-created session prompt delivery', () => {
  test('the session is recognised as trigger-created', () => {
    expect(isTriggerCreatedSessionMetadata(TRIGGER_SESSION_METADATA)).toBe(true);
  });

  test('REGRESSION: passing the target session id as the binding denies the manager', () => {
    // What deliverPrompt used to send. This is the 403 the incident produced.
    expect(visibleTo(SESSION_ID)).toBe(false);
  });

  test('passing null lets the project manager deliver into the trigger session', () => {
    expect(visibleTo(null)).toBe(true);
  });

  test('null does NOT widen access for a non-manager without grants', () => {
    expect(visibleTo(null, false)).toBe(false);
  });

  test('null leaves the sibling-narrowing verdict unchanged', () => {
    // The narrowing only ever fires for a backend-origin target, and the old
    // binding equalled the target session id — so it passed then and passes
    // now. This is why nulling the binding cannot reopen the sibling hole.
    for (const origin of ['schedule', 'backend', 'user'] as const) {
      const narrowing = {
        origin,
        sessionId: SESSION_ID,
        callerSessionId: 'supabase-login-session',
      };
      expect(
        isSessionTargetVisibleToCaller({ ...narrowing, boundCredentialSessionId: SESSION_ID }),
      ).toBe(isSessionTargetVisibleToCaller({ ...narrowing, boundCredentialSessionId: null }));
    }
  });

  test('a session-bound credential still cannot reach a SIBLING backend session', () => {
    // Unchanged behaviour, asserted so a future edit cannot quietly drop it.
    expect(
      isSessionTargetVisibleToCaller({
        origin: 'backend',
        sessionId: SESSION_ID,
        callerSessionId: 'some-other-session',
        boundCredentialSessionId: 'some-other-session',
      }),
    ).toBe(false);
  });

  test('deliverPrompt sends null as the bound credential binding', async () => {
    // The unit assertions above are about `share.ts`. This one pins the CALLER
    // so the fix cannot regress in engine.ts while the gate stays correct.
    const source = await Bun.file(new URL('./engine.ts', import.meta.url)).text();
    // The real forward, not one of the comments that name the route.
    const forward = source.indexOf(
      '/session/${encodeURIComponent(opencodeSessionId)}/prompt_async',
    );
    expect(forward).toBeGreaterThan(0);
    const window = source.slice(Math.max(0, forward - 1200), forward);
    expect(window).toContain('boundCredentialSessionId: null');
    expect(window).not.toContain('boundCredentialSessionId: callerSessionId');
  });
});
