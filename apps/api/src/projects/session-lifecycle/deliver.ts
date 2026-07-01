import type { Effect } from 'effect';
import type { SessionDeliveryOutcome } from './types';
import { sharedSleep } from '../../shared/effect';

// After a session's runtime reports `ready` we still have to hand the prompt to
// the opencode daemon — and a just-woken sandbox is flaky for a beat: the
// rotated opencode session 404s, the daemon 5xx/refuses while it finishes
// binding, or externalId/opencode_session_id read briefly null mid-resume. The
// old delivery path bounced to `pending` on the FIRST such hiccup, which on
// Slack told the user "still waking… send that again" and dropped their message
// even though the session was up. Slack/email delivery runs AFTER the inbound
// webhook is acked, so we are NOT racing a 3s budget here — keep healing and
// retrying the hand-off through the transient post-wake window before giving up.
const DELIVER_DEADLINE_MS = 45_000;
const DELIVER_RETRY_INTERVAL_MS = 1_500;

export interface DeliveryTarget {
  stage: string;
  externalId: string | null;
  opencodeSessionId: string | null;
}

// Pure, fully-injectable retry loop (mirrors awaitTerminalStage) so the wake/heal
// behavior is testable without wall-clock sleeps or sandbox mocks. `send` posts
// the prompt and returns whether the daemon accepted it; `reopen` re-resolves the
// session (which heals a rotated/expired opencode session — the 404 case) and is
// only called after a failed attempt.
export async function deliverWithRetry(input: {
  opened: DeliveryTarget;
  reopen: () => Promise<DeliveryTarget | null>;
  send: (externalId: string, opencodeSessionId: string) => Promise<boolean>;
  sessionId?: string;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  intervalMs?: number;
}): Promise<SessionDeliveryOutcome> {
  const now = input.now ?? Date.now;
  const sleepFn = input.sleepFn ?? sharedSleep;
  const deadlineMs = input.deadlineMs ?? DELIVER_DEADLINE_MS;
  const intervalMs = input.intervalMs ?? DELIVER_RETRY_INTERVAL_MS;

  let current = input.opened;
  const deadline = now() + deadlineMs;
  for (;;) {
    if (current.externalId && current.opencodeSessionId) {
      if (await input.send(current.externalId, current.opencodeSessionId)) return 'delivered';
    }
    if (now() >= deadline) {
      console.warn('[session-lifecycle] could not deliver prompt before deadline', {
        sessionId: input.sessionId,
        stage: current.stage,
        hasExternalId: !!current.externalId,
        hasOpencodeSession: !!current.opencodeSessionId,
      });
      return 'pending';
    }
    await sleepFn(intervalMs);
    const healed = await input.reopen();
    if (!healed) return 'no-session';
    if (healed.stage === 'failed' || healed.stage === 'stopped') return 'failed';
    current = healed;
  }
}
