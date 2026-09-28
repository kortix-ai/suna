import type { SessionDeliveryOutcome } from './types';
import { projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { transitionSession } from './status-transitions';
import { db } from '../../shared/db';
import { openSession } from '../routes/shared';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { serviceKeyForExternalId } from '../../platform/service-key';
import type { ProviderName } from '../../platform/providers';
import { syncSandboxEnvForPrompt } from '../lib/sandbox-env-sync';
import { recordSessionActivity } from '../session-activity';
import { deliveryCountsAsActivity } from './delivery-activity';
import { DAEMON_PORT, PromptNeverLandedError } from './runtime-client';
import type { ContinueSessionCommand } from './types';
import type { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { reloadVisibleSessionRow } from './visible-session-row';

const DELIVER_DEADLINE_MS = 45_000;
const DELIVER_RETRY_INTERVAL_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type SendOutcome = boolean | 'unreachable';

export interface DeliveryTarget {
  stage: string;
  externalId: string | null;
  opencodeSessionId: string | null;
}

export async function deliverWithRetry(input: {
  opened: DeliveryTarget;
  reopen: () => Promise<DeliveryTarget | null>;
  send: (externalId: string, opencodeSessionId: string) => Promise<SendOutcome>;
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
  let lastOutcome: SendOutcome = false;
  for (;;) {
    if (current.externalId && current.opencodeSessionId) {
      lastOutcome = await input.send(current.externalId, current.opencodeSessionId);
      if (lastOutcome === true) return 'delivered';
    }
    if (now() >= deadline) {
      const unreachable = lastOutcome === 'unreachable';
      console.warn('[session-lifecycle] could not deliver prompt before deadline', {
        sessionId: input.sessionId,
        stage: current.stage,
        hasExternalId: !!current.externalId,
        hasOpencodeSession: !!current.opencodeSessionId,
        outcome: unreachable ? 'unreachable' : 'pending',
      });
      return unreachable ? 'unreachable' : 'pending';
    }
    await sleepFn(intervalMs);
    const healed = await input.reopen();
    if (!healed) return 'no-session';
    if (healed.stage === 'failed' || healed.stage === 'stopped') return 'unreachable';
    current = healed;
  }
}

export interface WakeDeliveryContext {
  command: ContinueSessionCommand;
  session: { projectId: string };
  sessionId: string;
  userId: string;
  awakeEarly: Promise<DeliveryTarget | null>;
  sendPrompt: (externalId: string, opencodeSessionId: string) => Promise<SendOutcome>;
  beforeSend?: () => Promise<void>;
  tl?: ProvisionTimeline;
}

const READY_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

export async function deliverAfterWake(ctx: WakeDeliveryContext): Promise<SessionDeliveryOutcome> {
  const { command, session, sessionId, userId, awakeEarly, sendPrompt, beforeSend, tl } = ctx;
  let projectRow: typeof projects.$inferSelect | undefined;
  const loadProject = async () =>
    (projectRow ??= (await db.select().from(projects).where(eq(projects.projectId, session.projectId)).limit(1))[0]);
  const openOnce = async () => {
    const project = await loadProject();
    if (!project) return null;
    const loaded = { row: project, userId };
    await beforeSend?.();
    const fresh = await reloadVisibleSessionRow(sessionId);
    if (!fresh) return null;
    return openSession({
      loaded,
      visible: { row: fresh },
      projectId: session.projectId,
      sessionId,
    });
  };

  tl?.mark('session-read');

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

  const opened = await awaitReadyOpen(openOnce, sessionId, tl);
  if (typeof opened === 'string') return opened;
  const syncFailure = await syncBeforeWakeDelivery({ opened, sessionId, command, session });
  if (syncFailure) return syncFailure;

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
      if (deliveryCountsAsActivity(outcome)) {
        void recordSessionActivity({ sessionId, projectId: session.projectId });
      }
      return outcome;
    })
    .catch(notLandedOutcome);
}

function notLandedOutcome(error: unknown): SessionDeliveryOutcome {
  if (error instanceof PromptNeverLandedError) return 'not-landed';
  throw error;
}

export async function awakeDeliveryTarget(sessionId: string): Promise<DeliveryTarget | null> {
  const [[session], [box]] = await Promise.all([
    db
      .select({
        status: projectSessions.status,
        opencodeSessionId: projectSessions.opencodeSessionId,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1),
    db
      .select({
        status: sessionSandboxes.status,
        externalId: sessionSandboxes.externalId,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1),
  ]);
  if (!session || session.status !== 'running' || !session.opencodeSessionId) return null;
  if (!box || box.status !== 'active' || !box.externalId) return null;
  return {
    stage: 'ready',
    externalId: box.externalId,
    opencodeSessionId: session.opencodeSessionId,
  };
}

function sandboxExternalId(result: NonNullable<Awaited<ReturnType<typeof openSession>>>): string | null {
  return (result.sandbox as { external_id?: string } | null)?.external_id ?? null;
}

function isProviderName(value: string | null): value is ProviderName {
  return value === 'daytona' || value === 'platinum' || value === 'e2b';
}

export async function undoDeliveryWake(sessionId: string, wokeFrom: string): Promise<void> {
  await transitionSession(wokeFrom === 'completed' ? 'unwakeCompleted' : 'unwake', sessionId, {
    guard: sql`NOT EXISTS (
      SELECT 1 FROM ${sessionSandboxes} AS box
       WHERE box.session_id = ${sessionId}
         AND box.status = 'active')`,
  });
}

async function awaitReadyOpen(
  openOnce: () => Promise<Awaited<ReturnType<typeof openSession>> | null>,
  sessionId: string,
  tl?: ProvisionTimeline,
): Promise<Awaited<ReturnType<typeof openSession>> | 'no-session' | 'unreachable' | 'pending'> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  for (;;) {
    const opened = await openOnce();
    if (!opened) return 'no-session';
    if (opened.stage === 'ready') {
      tl?.mark('open-ready');
      return opened;
    }
    if (opened.stage === 'failed' || opened.stage === 'stopped') return 'unreachable';
    if (Date.now() >= deadline) {
      console.warn('[session-lifecycle] runtime not ready before delivery deadline', {
        sessionId,
        stage: opened.stage,
      });
      return 'pending';
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function syncBeforeWakeDelivery(input: {
  opened: NonNullable<Awaited<ReturnType<typeof openSession>>>;
  sessionId: string;
  command: ContinueSessionCommand;
  session: { projectId: string };
}): Promise<'pending' | null> {
  const { opened, sessionId, command, session } = input;
  const sandbox = opened.sandbox;
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
      resolveSandboxIngress(externalId, {
        port: DAEMON_PORT,
        transport: 'http',
      }),
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
  return null;
}
