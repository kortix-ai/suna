/**
 * Server-side delivery of a follow-up prompt into an EXISTING session's OpenCode
 * conversation — the single path every non-browser caller (chat channels today,
 * any future integration) uses.
 *
 * It owns NO sandbox lifecycle of its own. Bringing the session's runtime up —
 * resume a hibernated box, reprovision a destroyed one, resolve the canonical
 * OpenCode root — is delegated wholesale to `openSession`, the ONE idempotent
 * open path the dashboard polls on every session open. This module is just
 * "drive openSession to ready, then POST the prompt through the same
 * preview-proxy forwarder the browser uses." There is deliberately no second
 * resume engine here: a stale copy of that lifecycle is exactly what used to
 * diverge (e.g. mis-reading a prompt 404 as a deleted session) and reset threads.
 */

import { eq } from 'drizzle-orm';

import { projects, projectSessions } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { forwardToSandbox } from '../sandbox-proxy/routes/preview';
import { resolveGitTriggerActor } from './lib/triggers';
import { openSession, type SessionStartResult } from './routes/shared';

const WORKSPACE = '/workspace';
/** Daemon port; it reverse-proxies `/session/*` to OpenCode (same as the browser). */
const DAEMON_PORT = 8000;
// Generous ceiling: bringing a session back can mean a Daytona cold-storage
// restore or a full cold reprovision from the git branch. This runs in the
// fire-and-forget webhook handler, so a long wait costs nothing — the agent just
// replies a bit later. Exceeding it only yields `pending` (keep the mapping,
// never recreate), so it is a soft ceiling, not a failure.
const READY_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

/**
 * Outcome of delivering a follow-up prompt to an existing session.
 *   - `delivered`: OpenCode accepted the prompt.
 *   - `pending`: the session is alive but its runtime isn't ready this instant
 *     (provisioning / waking). The caller keeps the durable thread→session
 *     mapping and a retry — or the user's next message — lands. Never recreate.
 *   - `no-session`: the projectSessions row itself is gone (deleted; the
 *     chat_threads FK cascade already dropped the mapping). Only here may the
 *     caller start a replacement — never a duplicate of a live session.
 *   - `failed`: the session is terminally failed. Surface it honestly.
 */
export type SessionDeliveryOutcome = 'delivered' | 'pending' | 'no-session' | 'failed';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deliverPromptToSession(input: {
  sessionId: string;
  text: string;
}): Promise<SessionDeliveryOutcome> {
  const { sessionId, text } = input;

  // The SESSION is the durable thing (git branch + projectSessions row).
  const [session] = await db
    .select({ accountId: projectSessions.accountId, projectId: projectSessions.projectId, status: projectSessions.status })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  // Row gone → the session was deleted (the chat_threads FK cascade already
  // dropped the mapping). The caller may start a replacement.
  if (!session) return 'no-session';
  if (session.status === 'failed') return 'failed';

  const userId = await resolveGitTriggerActor(session.accountId);
  if (!userId) {
    console.warn('[session-delivery] no actor for account', session.accountId);
    return 'pending';
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, session.projectId))
    .limit(1);
  if (!project) return 'no-session';

  // A dormant session — hibernated to 'stopped', or 'completed' — must resurrect
  // on a new thread message. openSession resumes a hibernated box in place, but
  // reports a stopped/completed session with NO resumable box as terminal. Clear
  // the terminal status once so the open path rebuilds it from the durable git
  // branch. A genuinely 'failed' session stayed terminal above.
  if (session.status === 'stopped' || session.status === 'completed') {
    await db
      .update(projectSessions)
      .set({ status: 'running', error: null, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, sessionId));
  }

  // ── Bring the runtime up via the ONE canonical open path ──────────────────
  // openSession resumes/reprovisions the box and resolves the canonical OpenCode
  // pin — idempotent, identical to the dashboard's session-open, and re-read
  // fresh each call so its own double-provision guard works. It never delivers a
  // prompt and never (re-)injects the initial prompt, so polling here can't
  // replay the first message. We just wait for `ready`.
  const loaded = { row: project, userId };
  const openOnce = async (): Promise<SessionStartResult | null> => {
    const [fresh] = await db
      .select({
        status: projectSessions.status,
        sandboxProvider: projectSessions.sandboxProvider,
        baseRef: projectSessions.baseRef,
        agentName: projectSessions.agentName,
        opencodeSessionId: projectSessions.opencodeSessionId,
        accountId: projectSessions.accountId,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!fresh) return null;
    return openSession({ loaded, visible: { row: fresh }, projectId: session.projectId, sessionId });
  };

  const deadline = Date.now() + READY_DEADLINE_MS;
  let opened: SessionStartResult;
  for (;;) {
    const res = await openOnce();
    if (!res) return 'no-session';
    opened = res;
    if (opened.stage === 'ready') break;
    // Terminal: a failed session surfaces; a stopped one we already flipped above,
    // so reaching terminal-stopped here means the rebuild itself gave up.
    if (opened.stage === 'failed' || opened.stage === 'stopped') return 'failed';
    // provisioning | starting → keep the session + mapping and let a retry land.
    if (Date.now() >= deadline) {
      console.warn('[session-delivery] runtime not ready before deadline', { sessionId, stage: opened.stage });
      return 'pending';
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const externalId = sandboxExternalId(opened);
  if (!externalId || !opened.opencode_session_id) return 'pending';

  // ── Deliver through the same preview-proxy forwarder the browser uses ──────
  if (await postPrompt(externalId, opened.opencode_session_id, text, userId)) return 'delivered';

  // The resolved root went stale between openSession and the POST (orphaned root
  // / GC). Re-open once — openSession re-resolves the canonical pin on the SAME
  // session — and retry exactly once. Still failing → keep the session + mapping
  // as 'pending'; NEVER report 'no-session' (that would reset the thread).
  const healed = await openOnce();
  const healedId = healed?.opencode_session_id;
  if (healed?.stage === 'ready' && healedId && healedId !== opened.opencode_session_id) {
    if (await postPrompt(sandboxExternalId(healed) ?? externalId, healedId, text, userId)) return 'delivered';
  }
  return 'pending';
}

function sandboxExternalId(result: SessionStartResult): string | null {
  return (result.sandbox as { external_id?: string } | null)?.external_id ?? null;
}

// POST the prompt to OpenCode's prompt_async via the canonical forwarder. Returns
// true on accept; false on any non-ok (the caller decides whether to heal/retry).
async function postPrompt(
  externalId: string,
  opencodeSessionId: string,
  text: string,
  userId: string,
): Promise<boolean> {
  const body = new TextEncoder().encode(JSON.stringify({ parts: [{ type: 'text', text }] }));
  const res = await forwardToSandbox(
    externalId,
    DAEMON_PORT,
    userId,
    'POST',
    `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
    `?directory=${encodeURIComponent(WORKSPACE)}`,
    new Headers({ 'Content-Type': 'application/json' }),
    body.buffer as ArrayBuffer,
    config.KORTIX_URL ?? '',
  );
  if (res.ok || res.status === 204) return true;
  if (res.status !== 404) console.warn('[session-delivery] prompt_async non-ok', { status: res.status });
  return false;
}
