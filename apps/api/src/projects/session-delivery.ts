/**
 * Server-side delivery of a follow-up prompt into an EXISTING session's OpenCode
 * conversation — the single path every non-browser caller (chat channels today,
 * any future integration) should use.
 *
 * It is the server-side mirror of what the browser does on every chat send, and
 * it is built entirely from the platform's canonical primitives so there is
 * exactly ONE implementation of each concern (no bespoke per-channel sandbox
 * plumbing, no in-sandbox `/kortix/prompt` route, no fragile tmpfs pin):
 *
 *   1. WAKE the existing sandbox in place — `resumeStoppedSandbox` for a
 *      hibernated row (DB flip + compute reopen), `wakeSandbox` (ensureRunning)
 *      for a box the provider auto-stopped while the row still reads 'active'.
 *      Identical to what opening the session in the dashboard does; never a
 *      fresh sandbox.
 *   2. RESOLVE the canonical OpenCode root server-side via
 *      `ensureOpencodeSessionPin` (honor the stored pin, else the deterministic
 *      oldest root). This keeps a follow-up in the ORIGINAL conversation even
 *      after a cold-boot wake re-pins a fresh in-box session — the exact resolver
 *      the dashboard relies on.
 *   3. DELIVER through `forwardToSandbox`, the same preview-proxy forwarder the
 *      browser posts chat through: it enforces ownership, signs the user context,
 *      syncs project env before the prompt, and has its own auto-wake + retry.
 */

import { eq } from 'drizzle-orm';

import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { wakeSandbox } from '../sandbox-proxy/backend';
import { forwardToSandbox } from '../sandbox-proxy/routes/preview';
import { ensureOpencodeSessionPin } from './opencode-mapping';
import { resolveGitTriggerActor } from './lib/triggers';
import { kickProvisionOnOpen, resumeStoppedSandbox } from './routes/shared';

const WORKSPACE = '/workspace';
/** Daemon port; it reverse-proxies `/session/*` to OpenCode (same as the browser). */
const DAEMON_PORT = 8000;
/**
 * How long to wait for a just-woken box to become reachable before giving up.
 * A box idle long enough to be auto-archived to cold storage can take well over
 * a minute to restore + reboot OpenCode, so 90s was too tight and surfaced a
 * spurious "couldn't reach the sandbox" on a box that was merely still resuming.
 */
// Generous: bringing a session back can mean a Daytona cold-storage restore (a
// "stopped" box auto-archived to cold storage — slower to boot than a warm
// resume) or, in the rare destroyed/error case, a full cold reprovision from the
// git branch. This runs in the fire-and-forget webhook handler, so a long wait
// costs nothing and just means the agent replies a bit later — far better than
// bouncing the user with "try again". Exceeding it only yields `pending` (keep
// the mapping, never recreate), so it is a soft ceiling, not a failure.
const READY_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

/**
 * Outcome of delivering a follow-up prompt to an existing session.
 *   - `delivered`: OpenCode accepted the prompt.
 *   - `pending`: the session is ALIVE but its sandbox isn't ready this instant
 *     (provisioning, waking from hibernation, or a transient blip). The caller
 *     keeps the permanent thread→session mapping and NEVER creates a second
 *     session — a retry lands. There is no "give up and recreate" for a live
 *     session: the sandbox is a disposable cache under the durable session.
 *   - `no-session`: the projectSessions row itself is gone (the session was
 *     deleted; the chat_threads FK cascade should already have dropped the
 *     mapping too). Only here may the caller start a session for the thread —
 *     and that is a REPLACEMENT after deletion, never a duplicate of a live one.
 *   - `failed`: the session is in a terminal `failed` state (provisioning genuinely
 *     errored). This is the ONE honest failure — surface it; never silently loop
 *     or recreate. An archived/stopped box is NOT this: it resurrects.
 */
export type SessionDeliveryOutcome = 'delivered' | 'pending' | 'no-session' | 'failed';

export async function deliverPromptToSession(input: {
  sessionId: string;
  text: string;
}): Promise<SessionDeliveryOutcome> {
  const { sessionId, text } = input;

  // The SESSION is the durable thing (git branch + projectSessions row). Load it.
  const [session] = await db
    .select({
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      status: projectSessions.status,
      sandboxProvider: projectSessions.sandboxProvider,
      baseRef: projectSessions.baseRef,
      agentName: projectSessions.agentName,
      opencodeSessionId: projectSessions.opencodeSessionId,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  // Row gone → the session was deleted (the chat_threads FK cascade should already
  // have dropped the mapping). The caller may start a replacement.
  if (!session) return 'no-session';
  // Terminal failure is the ONE honest error. A stopped/cold/archived box is NOT
  // this — that resurrects. Only a genuinely failed session surfaces.
  if (session.status === 'failed') return 'failed';

  const userId = await resolveGitTriggerActor(session.accountId);
  if (!userId) {
    console.warn('[session-delivery] no actor for account', session.accountId);
    return 'pending';
  }

  // Full project row — needed to (re)provision a sandbox for this session exactly
  // the way opening it in the browser does.
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, session.projectId))
    .limit(1);
  if (!project) return 'no-session';

  const deadline = Date.now() + READY_DEADLINE_MS;

  // ── Ensure a LIVE, reachable sandbox for this session ──────────────────────
  // The session owns 100% of its sandbox lifecycle; the caller never touches it.
  //   • active            → ready
  //   • stopped (cold)    → start it back up in place (resumeStoppedSandbox →
  //                          provider.start, restoring from Daytona cold storage —
  //                          slower, but the same box/disk)
  //   • destroyed/missing → rebuild fresh from the durable git branch
  //                          (kickProvisionOnOpen — the browser's own open path)
  //   • error             → the one genuine failure → surface it
  // This is identical to the browser's session-open (r7).
  let externalId: string | null = null;
  let kickedReprovision = false;
  for (;;) {
    const [sb] = await db
      .select({
        sandboxId: sessionSandboxes.sandboxId,
        externalId: sessionSandboxes.externalId,
        provider: sessionSandboxes.provider,
        status: sessionSandboxes.status,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1);

    if (sb && sb.status === 'active' && sb.externalId) {
      externalId = sb.externalId;
      break;
    }
    if (sb && sb.status === 'error') return 'failed';
    if (sb && sb.status === 'stopped' && sb.externalId) {
      await resumeStoppedSandbox({
        sandboxId: sb.sandboxId,
        sessionId,
        accountId: session.accountId,
        provider: sb.provider,
        externalId: sb.externalId,
      });
    } else if (!sb || sb.status === 'archived' || (!sb.externalId && sb.status !== 'provisioning')) {
      // No usable box — rebuild from the branch. kickProvisionOnOpen flips the
      // session to 'provisioning' synchronously, so re-reading the session status
      // is the cross-call/replica guard against a double-kick; we also kick at
      // most once per call. Mirror r7: drop the dead row first so provision inserts
      // cleanly.
      const [live] = await db
        .select({ status: projectSessions.status })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      if (!live) return 'no-session';
      if (live.status === 'failed') return 'failed';
      if (live.status !== 'provisioning' && !kickedReprovision) {
        if (sb) {
          await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sb.sandboxId)).catch(() => {});
        }
        await kickProvisionOnOpen(
          { row: project, userId },
          { sandboxProvider: session.sandboxProvider, baseRef: session.baseRef, agentName: session.agentName },
          session.projectId,
          sessionId,
        );
        kickedReprovision = true;
      }
    }
    // else: provisioning in flight — just wait.

    if (Date.now() >= deadline) {
      console.warn('[session-delivery] sandbox not ready before deadline', { sessionId });
      return 'pending';
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await wakeSandbox(externalId);

  // ── Resolve the canonical OpenCode root, then deliver ──────────────────────
  // A resumed box keeps its chat (continue it: allowCreate=false). A box we just
  // rebuilt from scratch has none, so let the pin be created (allowCreate=true).
  let opencodeSessionId: string | null = null;
  for (;;) {
    const ensured = await ensureOpencodeSessionPin({
      projectId: session.projectId,
      sessionId,
      accountId: session.accountId,
      externalId,
      userId,
      currentPin: session.opencodeSessionId ?? null,
      allowCreate: kickedReprovision,
    });
    if (ensured.pin) {
      opencodeSessionId = ensured.pin;
      break;
    }
    if (Date.now() >= deadline) {
      console.warn('[session-delivery] opencode unresolved after wake', {
        sessionId,
        reason: ensured.reason,
      });
      // Box is alive but OpenCode hasn't answered yet. Keep the session + mapping
      // and let a retry land — never error the box or recreate the session.
      return 'pending';
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // 3. Deliver through the canonical preview-proxy forwarder — the same request
  //    the browser makes (auth, user-context signing, project-env sync, auto-wake
  //    + retry all live there). No bespoke daemon route, no tmpfs pin.
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

  if (res.ok || res.status === 204) return 'delivered';
  if (res.status === 404) return 'no-session';
  console.warn('[session-delivery] prompt_async non-ok', { sessionId, status: res.status });
  return 'pending';
}
