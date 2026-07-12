import type { SessionDeliveryOutcome } from './types';

// After a session's runtime reports `ready` we still have to hand the prompt to
// the ACP adapter — and a just-woken sandbox is flaky for a beat: the adapter
// can 404/5xx/refuse while it finishes binding, or externalId/runtime_id can
// read briefly null mid-resume. Slack/email delivery runs AFTER the inbound
// webhook is acked, so we are NOT racing a 3s budget here — keep healing and
// retrying the hand-off through the transient post-wake window before giving up.
const DELIVER_DEADLINE_MS = 45_000;
const DELIVER_RETRY_INTERVAL_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DeliveryTarget {
  stage: string;
  externalId: string | null;
  runtimeProtocol?: 'acp' | null;
  runtimeId?: string | null;
  runtimeSessionId?: string | null;
}

// Pure, fully-injectable retry loop (mirrors awaitTerminalStage) so the wake/heal
// behavior is testable without wall-clock sleeps or sandbox mocks. `send` posts
// the prompt and returns whether the ACP adapter accepted it; `reopen` re-resolves
// the session and is only called after a failed attempt.
export async function deliverWithRetry(input: {
  opened: DeliveryTarget;
  reopen: () => Promise<DeliveryTarget | null>;
  send: (externalId: string, runtimeId: string, target: DeliveryTarget) => Promise<boolean>;
  sessionId?: string;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  intervalMs?: number;
}): Promise<SessionDeliveryOutcome> {
  const now = input.now ?? Date.now;
  const sleepFn = input.sleepFn ?? sleep;
  const deadlineMs = input.deadlineMs ?? DELIVER_DEADLINE_MS;
  const intervalMs = input.intervalMs ?? DELIVER_RETRY_INTERVAL_MS;

  let current = input.opened;
  const deadline = now() + deadlineMs;
  for (;;) {
    const deliverableId = current.runtimeProtocol === 'acp' ? current.runtimeId : null;
    if (current.externalId && deliverableId) {
      if (await input.send(current.externalId, deliverableId, current)) return 'delivered';
    }
    if (now() >= deadline) {
      console.warn('[session-lifecycle] could not deliver prompt before deadline', {
        sessionId: input.sessionId,
        stage: current.stage,
        hasExternalId: !!current.externalId,
        runtimeProtocol: current.runtimeProtocol ?? null,
        hasRuntimeId: !!current.runtimeId,
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
