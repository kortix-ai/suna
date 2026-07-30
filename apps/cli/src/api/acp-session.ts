import {
  type AcpContentBlock,
  type AcpMessageWithParts,
  type AcpSessionController,
  applyAcpEnvelope,
  createAcpClient,
  createAcpProjection,
  createAcpSessionController,
  persistProjectSessionAcpIdentity,
} from '@kortix/sdk';

import type { Auth } from './auth.ts';
import { sdkBackendUrl, withKortixScope } from './sdk.ts';
import type { ProjectSession } from './types.ts';

/**
 * The CLI's ACP surface, built entirely on the SDK's ACP runtime
 * (`createAcpSessionController`). There is no second ACP implementation here —
 * this module only resolves identity off the Kortix session row, binds the
 * durable platform endpoint, and adapts the controller's push-snapshot model to
 * the CLI's request/response shape.
 *
 * It replaces the hand-rolled OpenCode REST client the CLI used to carry.
 * Under managed ACP the in-sandbox OpenCode REST server is never started
 * (`apps/kortix-sandbox-agent-server/src/main.ts`), so every one of those calls
 * was dead.
 */

export type AcpRuntimeHarness = 'claude' | 'codex' | 'opencode' | 'pi';

export interface AcpSessionTarget {
  /** Sandbox ACP process key. Enables the managed multi-harness lifecycle. */
  acpServerId: string;
  /** Harness-native conversation id. Null makes the controller issue session/new. */
  acpSessionId: string | null;
  runtimeHarness?: AcpRuntimeHarness;
  nativeAgent: string | null;
}

const HARNESSES = new Set<string>(['claude', 'codex', 'opencode', 'pi']);

/**
 * The DURABLE platform ACP endpoint — `/projects/:pid/sessions/:sid/acp` — not
 * the in-sandbox bridge. The platform route is the one that also serves
 * `/transcript` out of `kortix.acp_session_envelopes`, so a transcript read does
 * not depend on the box being alive.
 */
export function acpEndpointForSession(auth: Auth, projectId: string, sessionId: string): string {
  const base = sdkBackendUrl(auth.api_base);
  return `${base}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/acp`;
}

/** Read the harness-native ACP identity off a Kortix session row. */
export function acpSessionTargetFromSession(session: ProjectSession): AcpSessionTarget {
  const harness = session.runtime_harness;
  return {
    acpServerId: session.acp_server_id ?? session.session_id,
    acpSessionId: session.acp_session_id ?? null,
    ...(harness && HARNESSES.has(harness) ? { runtimeHarness: harness as AcpRuntimeHarness } : {}),
    nativeAgent: session.native_agent ?? null,
  };
}

/**
 * Fold stored ACP envelopes into renderable messages. Pure — no sandbox, no
 * network. This is what lets the CLI read a STOPPED session's conversation.
 */
export function projectEnvelopes(
  sessionId: string,
  rows: Array<{ ordinal: number; envelope: unknown }>,
): AcpMessageWithParts[] {
  let projection = createAcpProjection(sessionId);
  for (const row of rows) {
    projection = applyAcpEnvelope(projection, row.envelope as never);
  }
  return projection.messages;
}

export interface OpenAcpSessionOptions {
  auth: Auth;
  projectId: string;
  session: ProjectSession;
  /** Load persisted envelopes before streaming, so history is on screen. */
  durableTranscript?: boolean;
}

/**
 * Connect the SDK's ACP session controller to a live session.
 *
 * `session/load` is a JSON-RPC call into the harness, so this requires a
 * reachable sandbox — a stopped session genuinely cannot accept a prompt. Read
 * paths that must survive a dead box use {@link readAcpTranscript} instead.
 */
export async function openAcpSession(opts: OpenAcpSessionOptions): Promise<AcpSessionController> {
  const { auth, projectId, session } = opts;
  const target = acpSessionTargetFromSession(session);
  const controller = createAcpSessionController({
    sessionId: session.session_id,
    acpServerId: target.acpServerId,
    acpSessionId: target.acpSessionId,
    ...(target.runtimeHarness ? { runtimeHarness: target.runtimeHarness } : {}),
    nativeAgent: target.nativeAgent,
    endpoint: acpEndpointForSession(auth, projectId, session.session_id),
    durableTranscript: opts.durableTranscript ?? true,
    // A fresh session has no harness-native id yet. The controller mints one
    // via session/new and must claim it before it accepts prompts, or the next
    // CLI invocation would start a second conversation on the same box.
    persistAcpSessionId: async (acpSessionId: string) => {
      const claimed = await withKortixScope(auth, async () =>
        persistProjectSessionAcpIdentity(projectId, session.session_id, {
          acp_server_id: target.acpServerId,
          runtime_harness: (target.runtimeHarness ?? 'opencode') as AcpRuntimeHarness,
          acp_session_id: acpSessionId,
        }),
      );
      return claimed.acp_session_id;
    },
  });
  await withKortixScope(auth, async () => controller.connect());
  return controller;
}

/**
 * Read a session's persisted ACP transcript as renderable messages.
 *
 * Reads `/projects/:pid/sessions/:sid/acp/transcript`, which the API serves out
 * of Postgres — so it works for a `stopped` session whose sandbox is gone.
 */
export async function readAcpTranscript(
  auth: Auth,
  projectId: string,
  session: ProjectSession,
): Promise<AcpMessageWithParts[]> {
  const target = acpSessionTargetFromSession(session);
  const rows = await withKortixScope(auth, async () => {
    const client = createAcpClient({
      endpoint: acpEndpointForSession(auth, projectId, session.session_id),
    });
    const transcript = await client.transcript();
    return transcript.envelopes;
  });
  return projectEnvelopes(target.acpSessionId ?? session.session_id, rows);
}

/**
 * The newest assistant message at or after `baselineIndex`. Used to pick the
 * reply that belongs to the turn just submitted rather than a prior one.
 */
export function assistantReplyAfter(
  messages: AcpMessageWithParts[],
  baselineIndex: number,
): AcpMessageWithParts | null {
  for (let i = messages.length - 1; i >= baselineIndex; i -= 1) {
    const message = messages[i];
    if (message?.info.role === 'assistant') return message;
  }
  return null;
}

export interface SendAcpPromptOptions {
  agent?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const SETTLE_POLL_INTERVAL_MS = 100;

function isSettled(snapshot: {
  sending: boolean;
  projection: { status: { type: string }; permissions: unknown[]; questions: unknown[] };
}): boolean {
  if (snapshot.sending) return false;
  if (snapshot.projection.status.type !== 'idle') return false;
  // A turn parked on an approval or a question is NOT finished; returning here
  // would print an empty reply and hide the thing that needs answering.
  return snapshot.projection.permissions.length === 0 && snapshot.projection.questions.length === 0;
}

/**
 * Submit one turn and resolve with the assistant reply.
 *
 * The controller's `send()` resolves on the `session/prompt` RPC result, which
 * can land before the harness has emitted its content; quiescence is what the
 * CLI needs. So settle on the controller's own liveness signal — `sending`
 * false, projection idle, and nothing blocking on an approval/question.
 */
export async function sendAcpPromptAndWait(
  controller: AcpSessionController,
  text: string,
  opts: SendAcpPromptOptions = {},
): Promise<AcpMessageWithParts> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const baselineIndex = controller.getSnapshot().projection.messages.length;
  const prompt: AcpContentBlock[] = [{ type: 'text', text }];
  const sendOptions = {
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };

  await controller.send(prompt, sendOptions);

  for (;;) {
    const snapshot = controller.getSnapshot();
    if (snapshot.error) throw snapshot.error;
    if (isSettled(snapshot as never)) {
      const reply = assistantReplyAfter(snapshot.projection.messages, baselineIndex);
      if (reply) return reply;
      return { info: { role: 'assistant' } as never, parts: [] };
    }
    if (Date.now() >= deadline) {
      throw new Error(`agent reply timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_INTERVAL_MS));
  }
}

/** Blocking approvals + questions the agent is waiting on, from the projection. */
export function pendingApprovals(controller: AcpSessionController): {
  permissions: AcpSessionController extends never ? never : Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
} {
  const { projection } = controller.getSnapshot();
  return {
    permissions: projection.permissions as never,
    questions: projection.questions as never,
  };
}
