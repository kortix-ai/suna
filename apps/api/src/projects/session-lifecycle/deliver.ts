import type { ContinueSessionCommand, SessionDeliveryOutcome } from './types';
import type { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { openSession } from '../routes/shared';
import { type SandboxRecord, resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { serviceKeyForExternalId } from '../../platform/service-key';
import type { ProviderName } from '../../platform/providers';
import { healSupersededSessionToken } from '../lib/heal-session-token';
import { syncSandboxEnvForPrompt } from '../lib/sandbox-env-sync';
import { recordSessionActivity } from '../session-activity';
import { deliveryCountsAsActivity } from './delivery-activity';
import { DAEMON_PORT, PromptNeverLandedError } from './runtime-client';
import { waitForSessionRuntimeActive } from './runtime-active-signal';
import { sessionTransitionLeaves, transitionSession } from './status-transitions';

// After a session's runtime reports `ready` we still have to hand the prompt to
// the opencode daemon — and a just-woken sandbox is flaky for a beat: the
// rotated opencode session 404s, the daemon 5xx/refuses while it finishes
// binding, or externalId/opencode_session_id read briefly null mid-resume. The
// old delivery path bounced to `pending` on the FIRST such hiccup, which on
// Slack told the user "still waking… send that again" and dropped their message
// even though the session was up. Slack/email delivery runs AFTER the inbound
// webhook is acked, so we are NOT racing a 3s budget here — keep healing and
// retrying the hand-off through the transient post-wake window before giving up.
//
// T13: this loop's OWN retries (below, within `deadlineMs`) send the
// same `send(...)` body every attempt, so they are safe to repeat by
// construction — `apps/api/src/sandbox-proxy/prompt-dedupe.ts`'s claim,
// reached through the SAME `forwardToSandbox` call `send` makes, absorbs them.
// A 'pending' RETURN from this function is a different case: the CALLER
// (`executeQueuedContinue` in `queued-continue.ts`) may re-invoke this whole loop later,
// from a fresh queued-command drain. That re-invocation's no-blind-repost
// guarantee is documented on `executeQueuedContinue`, not here — this file has
// no knowledge of the caller's retry cadence.
const DELIVER_DEADLINE_MS = 45_000;
const DELIVER_RETRY_INTERVAL_MS = 1_500;

/**
 * What one hand-off attempt proved.
 *
 *  `true`          — the runtime holds the prompt.
 *  `false`         — the daemon ANSWERED and refused. It is reachable, so
 *                    `reopen` can heal it (the rotated opencode session 404).
 *  `'unreachable'` — nobody answered FOR the runtime: the proxy returned
 *                    502/503/504, or the fetch threw/timed out. Nothing about
 *                    the prompt is wrong and re-opening the session cannot fix
 *                    it — the path to the box is down.
 *
 * The third case used to be folded into `false`, so a spent deadline always
 * reported 'pending', which `executeQueuedContinue` retries on the 5-attempt
 * dead-letter budget: ~5 minutes, then the user's message is destroyed. Prod
 * 2026-09-15/16, a Platinum control-plane fault that refused every POST while
 * GETs served normally, dead-lettered queued prompts at ~48/hour under
 * "Not sent — delivery outcome pending". A down path to the box is exactly
 * what the `unreachable` ladder exists for.
 */
export type SendOutcome = boolean | 'unreachable';

export interface DeliveryTarget {
  stage: string;
  externalId: string | null;
  opencodeSessionId: string | null;
  /** The sandbox row this target was read from, as the proxy wants it. The
   *  first hand-off passes it to `forwardToSandbox`, which otherwise loads the
   *  same row again. A re-opened target carries none: the proxy reads fresh. */
  record?: SandboxRecord;
}

// Pure, fully-injectable retry loop (mirrors awaitTerminalStage) so the wake/heal
// behavior is testable without wall-clock sleeps or sandbox mocks. `send` posts
// the prompt and returns whether the daemon accepted it; `reopen` re-resolves the
// session (which heals a rotated/expired opencode session — the 404 case) and is
// only called after a failed attempt.
export async function deliverWithRetry(input: {
  opened: DeliveryTarget;
  reopen: () => Promise<DeliveryTarget | null>;
  send: (externalId: string, opencodeSessionId: string, record?: SandboxRecord) => Promise<SendOutcome>;
  sessionId?: string;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  intervalMs?: number;
}): Promise<SessionDeliveryOutcome> {
  const now = input.now ?? Date.now;
  const sleepFn = input.sleepFn ?? Bun.sleep;
  const deadlineMs = input.deadlineMs ?? DELIVER_DEADLINE_MS;
  const intervalMs = input.intervalMs ?? DELIVER_RETRY_INTERVAL_MS;

  let current = input.opened;
  const deadline = now() + deadlineMs;
  // What the most recent attempt proved. The deadline below is reached
  // immediately after an attempt, so the last verdict is the freshest evidence
  // of why the hand-off is not landing.
  let lastOutcome: SendOutcome = false;
  for (;;) {
    if (current.externalId && current.opencodeSessionId) {
      lastOutcome = await input.send(current.externalId, current.opencodeSessionId, current.record);
      if (lastOutcome === true) return 'delivered';
    }
    if (now() >= deadline) {
      const unreachable = lastOutcome === 'unreachable';
      console.warn('[session-lifecycle] could not deliver prompt before deadline', {
        sessionId: input.sessionId,
        stage: current.stage,
        hasExternalId: !!current.externalId,
        hasOpencodeSession: !!current.opencodeSessionId,
        // The two answers differ by minutes of patience for the user's
        // message — see SendOutcome.
        outcome: unreachable ? 'unreachable' : 'pending',
      });
      return unreachable ? 'unreachable' : 'pending';
    }
    await sleepFn(intervalMs);
    const healed = await input.reopen();
    if (!healed) return 'no-session';
    // NOT a delivery failure — the RUNTIME is down. `stopped` is a hibernated
    // box, `failed` is a parked one; both come back, and this prompt has to
    // still be here when they do. Returning `failed` here dead-lettered the
    // user's message on its first attempt.
    if (healed.stage === 'failed' || healed.stage === 'stopped') return 'unreachable';
    current = healed;
  }
}

const READY_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;
/** After the box went active: the pause before re-opening a session that is
 *  not `ready` yet (the daemon is still binding). */
const ACTIVE_RECHECK_MS = 500;

interface WakeDeliveryContext {
  command: ContinueSessionCommand;
  session: { projectId: string; accountId: string };
  sessionId: string;
  userId: string;
  awakeEarly: Promise<DeliveryTarget | null>;
  sendPrompt: (externalId: string, opencodeSessionId: string, record?: SandboxRecord) => Promise<SendOutcome>;
  beforeSend?: () => Promise<void>;
  tl?: ProvisionTimeline;
}

export async function deliverAfterWake(ctx: WakeDeliveryContext): Promise<SessionDeliveryOutcome> {
  const { command, session, sessionId, userId, awakeEarly, sendPrompt, beforeSend, tl } = ctx;
  // Loaded LAZILY: only `openSession` (the slow path that wakes a box) reads
  // the project row, and the session's foreign key already proves it exists.
  // On the fast path this saved a full round trip per delivery.
  let projectRow: typeof projects.$inferSelect | undefined;
  const loadProject = async () =>
    (projectRow ??= (
      await db.select().from(projects).where(eq(projects.projectId, session.projectId)).limit(1)
    )[0]);


    const openOnce = async () => {
      const project = await loadProject();
      if (!project) return null;
      const loaded = { row: project, userId };
      await beforeSend?.();
      const [fresh] = await db
        .select({
          status: projectSessions.status,
          sandboxProvider: projectSessions.sandboxProvider,
          baseRef: projectSessions.baseRef,
          agentName: projectSessions.agentName,
          runtimeSessionId: projectSessions.runtimeSessionId,
          accountId: projectSessions.accountId,
          metadata: projectSessions.metadata,
        })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sessionId))
        .limit(1);
      if (!fresh) return null;
      // A message can wake a stopped box without /start; heal its token first.
      await healSupersededSessionToken(sessionId);
      return openSession({
        loaded,
        visible: { row: fresh },
        projectId: session.projectId,
        sessionId,
      });
    };

    tl?.mark('session-read');

    // FAST PATH — the box is already awake. `openSession` is /start: a provider
    // status call plus a daemon health probe, ~0.5–0.9s per delivery even when
    // nothing needs waking, and it ran on EVERY queued message. When the session
    // row is running, its sandbox row is active and the OpenCode pin exists, the
    // delivery target is fully known from the DB; the POST goes through the
    // proxy, whose own wake-and-retry loop and `deliverWithRetry.reopen` (the
    // full open) cover a box that turns out to be asleep after all. A cold or
    // stopping session takes the slow path below exactly as before.
    const awake = await awakeEarly;
    if (awake && !command.opencodeEnv) {
      tl?.mark('open-ready-fast');
      return deliverWithRetry({
        sessionId,
        opened: awake,
        reopen: async () => {
          const healed = await openOnce();
          if (!healed) return null;
          return {
            stage: healed.stage,
            externalId: sandboxExternalId(healed),
            opencodeSessionId: healed.opencode_session_id,
          };
        },
        send: sendPrompt,
      }).catch(notLandedOutcome);
    }

    const deadline = Date.now() + READY_DEADLINE_MS;
    let opened: Awaited<ReturnType<typeof openOnce>>;
    // The provision signals when the box goes active (`runtime-active-signal`),
    // so this loop re-opens at once instead of up to 3 s later.
    let boxActive = false;
    for (;;) {
      opened = await openOnce();
      if (!opened) return 'no-session';
      if (opened.stage === 'ready') {
        tl?.mark('open-ready');
        break;
      }
      // Runtime down, prompt fine. See `deliverWithRetry`'s identical branch.
      if (opened.stage === 'failed' || opened.stage === 'stopped') return 'unreachable';
      if (Date.now() >= deadline) {
        console.warn('[session-lifecycle] runtime not ready before delivery deadline', {
          sessionId,
          stage: opened.stage,
        });
        return 'pending';
      }
      boxActive =
        (await waitForSessionRuntimeActive(sessionId, boxActive ? ACTIVE_RECHECK_MS : POLL_INTERVAL_MS)) ||
        boxActive;
    }

    // Converge the box BEFORE the prompt goes on the wire — every time, not only
    // when this prompt carries an `opencodeEnv` override. The proxied
    // `prompt_async` route has always done this (sandbox-proxy/pre-prompt-env-sync);
    // this wake path did it only behind `if (command.opencodeEnv)`, so an ordinary
    // `session.send()` prompt onto a box that had to be WOKEN reached OpenCode
    // with whatever the box had at boot: a stale gateway base URL after a
    // KORTIX_URL rotation, stale secrets, a stale model catalog. The sync is
    // cheap and self-deduping (revision + model signature); an unchanged box
    // costs one skipped push.
    {
      const sandbox = opened.sandbox as {
        external_id?: string | null;
        provider?: string | null;
      } | null;
      const externalId = sandbox?.external_id ?? null;
      const providerName = sandbox?.provider ?? null;
      if (!externalId || !isProviderName(providerName)) {
        console.warn('[session-lifecycle] runtime env sync target is incomplete', {
          sessionId,
          hasExternalId: !!externalId,
          provider: providerName,
        });
        return 'pending';
      }
      try {
        const [serviceKey, ingress] = await Promise.all([
          serviceKeyForExternalId(externalId),
          resolveSandboxIngress(externalId, { port: DAEMON_PORT, transport: 'http' }),
        ]);
        if (!serviceKey) throw new Error('sandbox service key is unavailable');
        await syncSandboxEnvForPrompt({
          projectId: session.projectId,
          sessionId,
          externalId,
          serviceKey,
          previewUrl: ingress.url,
          providerHeaders: ingress.headers,
          providerName,
          opencodeEnv: command.opencodeEnv,
        });
      } catch (err) {
        console.warn('[session-lifecycle] runtime env sync failed before prompt delivery', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return 'pending';
      }
    }

    // Runtime is ready — hand off the prompt, healing + retrying through the
    // transient failures a freshly-woken sandbox throws (rotated opencode session
    // 404, daemon 5xx while it binds, externalId/opencode_session_id briefly
    // null). Bounce to 'pending' only after the bounded window genuinely exhausts;
    // the old code gave up on the first hiccup and dropped the user's message.
    const toTarget = (o: NonNullable<Awaited<ReturnType<typeof openOnce>>>): DeliveryTarget => ({
      stage: o.stage,
      externalId: sandboxExternalId(o),
      opencodeSessionId: o.opencode_session_id,
    });

    tl?.mark('env-sync');
    return deliverWithRetry({
      sessionId,
      opened: toTarget(opened),
      reopen: async () => {
        const healed = await openOnce();
        return healed ? toTarget(healed) : null;
      },
      send: sendPrompt,
    })
      .then((outcome) => {
        // Stamp the sidebar's sort key for a prompt the PLATFORM delivered — a
        // spawned sub-session, a trigger, a channel message, an approval resume.
        // The preview proxy already does this for a prompt a browser sends; this
        // path never did, so those sessions fell back to `updated_at`, which a
        // dozen background writers advance with no turn behind them, and they
        // visibly reordered themselves in the sidebar. Best-effort and never
        // awaited, exactly as at the proxy: a failed stamp degrades ordering and
        // must never degrade the prompt.
        if (deliveryCountsAsActivity(outcome)) {
          void recordSessionActivity({ sessionId, projectId: session.projectId });
        }
        return outcome;
      })
      .catch(notLandedOutcome);
}

/**
 * Put a session the delivery woke back to the status it woke from — only
 * while it still reads `running` and no `active` sandbox row backs it. A wake
 * that did bring the box up (`openSession` finalized the sandbox row) keeps
 * the session running.
 */
export async function undoDeliveryWake(sessionId: string, wokeFrom: string): Promise<void> {
  await transitionSession(wokeFrom === 'completed' ? 'unwakeCompleted' : 'unwake', sessionId, {
    guard: sql`NOT EXISTS (
      SELECT 1 FROM ${sessionSandboxes} AS box
       WHERE box.session_id = ${sessionId}
         AND box.status = 'active')`,
  });
}

/** A refused landing proof is its own outcome; anything else keeps throwing. */
function notLandedOutcome(error: unknown): SessionDeliveryOutcome {
  if (error instanceof PromptNeverLandedError) return 'not-landed';
  throw error;
}

/**
 * The delivery target for a session whose box is ALREADY awake, from the DB
 * alone — or null, which means "take the full open path". Cheap: two indexed
 * reads, no provider or daemon round-trip.
 *
 * The two reads are keyed on the same session id and neither consumes the
 * other's result, so they go out TOGETHER: one round trip instead of two on
 * every delivery, which is ~100 ms wherever the API and its database sit in
 * different regions.
 */
export async function awakeDeliveryTarget(sessionId: string): Promise<DeliveryTarget | null> {
  const [[session], [box]] = await Promise.all([
    db
      .select({
        status: projectSessions.status,
        opencodeSessionId: projectSessions.runtimeSessionId,
        agentName: projectSessions.agentName,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1),
    db
      .select({
        status: sessionSandboxes.status,
        externalId: sessionSandboxes.externalId,
        sandboxId: sessionSandboxes.sandboxId,
        projectId: sessionSandboxes.projectId,
        accountId: sessionSandboxes.accountId,
        provider: sessionSandboxes.provider,
        baseUrl: sessionSandboxes.baseUrl,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1),
  ]);
  if (!session || session.status !== 'running' || !session.opencodeSessionId) return null;
  if (!box || box.status !== 'active' || !box.externalId) return null;
  const serviceKey = (box.config as { serviceKey?: unknown } | null)?.serviceKey;
  return {
    stage: 'ready',
    externalId: box.externalId,
    opencodeSessionId: session.opencodeSessionId,
    // The same fields `loadSandbox` returns, from the two rows already in hand.
    record: {
      sandboxId: box.sandboxId,
      externalId: box.externalId,
      sessionId,
      agentName: session.agentName ?? null,
      projectId: box.projectId,
      accountId: box.accountId,
      provider: box.provider,
      status: box.status,
      baseUrl: box.baseUrl || '',
      serviceKey: typeof serviceKey === 'string' ? serviceKey : null,
    },
  };
}

function sandboxExternalId(
  result: NonNullable<Awaited<ReturnType<typeof openSession>>>,
): string | null {
  return (result.sandbox as { external_id?: string } | null)?.external_id ?? null;
}

function isProviderName(value: string | null): value is ProviderName {
  return value === 'daytona' || value === 'platinum' || value === 'e2b';
}
