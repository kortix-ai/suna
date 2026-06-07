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

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { wakeSandbox } from '../sandbox-proxy/backend';
import { forwardToSandbox } from '../sandbox-proxy/routes/preview';
import { ensureOpencodeSessionPin } from './opencode-mapping';
import { resolveGitTriggerActor } from './lib/triggers';
import { resumeStoppedSandbox } from './routes/shared';

const WORKSPACE = '/workspace';
/** Daemon port; it reverse-proxies `/session/*` to OpenCode (same as the browser). */
const DAEMON_PORT = 8000;
/** How long to wait for a just-woken box to become reachable before giving up. */
const WAKE_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;

/**
 * Outcome of delivering a follow-up prompt to an existing session.
 *   - `delivered`: OpenCode accepted the prompt.
 *   - `transient`: the sandbox is reachable-but-not-ready (booting/busy) or hit a
 *     blip; retrying the same session later should land.
 *   - `gone`: the session's sandbox is permanently unusable (missing, archived,
 *     errored, or 404) — recover by starting a fresh session.
 */
export type SessionDeliveryOutcome = 'delivered' | 'transient' | 'gone';

export async function deliverPromptToSession(input: {
  sessionId: string;
  text: string;
}): Promise<SessionDeliveryOutcome> {
  const { sessionId, text } = input;

  const [sandbox] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
      projectId: sessionSandboxes.projectId,
      accountId: sessionSandboxes.accountId,
      status: sessionSandboxes.status,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);

  if (!sandbox?.externalId) return 'gone';
  if (sandbox.status === 'archived' || sandbox.status === 'error') return 'gone';
  const externalId = sandbox.externalId;

  // The acting principal — the project's canonical actor, same one triggers run
  // as. forwardToSandbox enforces ownership against it, so without one we can't
  // deliver as an authorized caller.
  const userId = await resolveGitTriggerActor(sandbox.accountId);
  if (!userId) {
    console.warn('[session-delivery] no actor for account', sandbox.accountId);
    return 'transient';
  }

  // 1. Wake the existing box in place (same as opening the session in the UI).
  if (sandbox.status === 'stopped') {
    await resumeStoppedSandbox({
      sandboxId: sandbox.sandboxId,
      sessionId,
      accountId: sandbox.accountId,
      provider: sandbox.provider,
      externalId,
    });
  }
  await wakeSandbox(externalId);

  // 2. Resolve the canonical OpenCode root, polling while the woken box boots
  //    (ensureOpencodeSessionPin reaches into the box and is unreachable until
  //    OpenCode is back up). allowCreate:false — a follow-up continues an
  //    existing chat, it must never spin up a blank one.
  const [sessionRow] = await db
    .select({ opencodeSessionId: projectSessions.opencodeSessionId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  const deadline = Date.now() + WAKE_DEADLINE_MS;
  let opencodeSessionId: string | null = null;
  for (;;) {
    const ensured = await ensureOpencodeSessionPin({
      projectId: sandbox.projectId,
      sessionId,
      accountId: sandbox.accountId,
      externalId,
      userId,
      currentPin: sessionRow?.opencodeSessionId ?? null,
      allowCreate: false,
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
      return 'transient';
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
  if (res.status === 404) return 'gone';
  console.warn('[session-delivery] prompt_async non-ok', { sessionId, status: res.status });
  return 'transient';
}
