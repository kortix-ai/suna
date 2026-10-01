/**
 * The sandbox daemon (kortixd) wire, in both directions it has with apps/api:
 * the callbacks the daemon posts, and the `harness` block and capability names
 * its `GET /kortix/health` serves.
 *
 * kortixd bundles this file into the guest binary, so it imports nothing but
 * zod. Every name here is harness-neutral: an OpenCode box and a pi box send
 * the same fields.
 *
 * `normalizeRuntimeRelayBody` accepts the pre-W3 spellings a daemon built
 * before these names existed still sends (`opencode_session_id`, turn-stream
 * kind `opencode_session`). Remove it when no such daemon runs.
 */
import { z } from 'zod';

/** `POST /v1/projects/:projectId/turn-stream` kinds the daemon sends. */
export const DAEMON_TURN_STREAM_KINDS = [
  'initial_turn_claim',
  'turn_accepted',
  'turn_abandoned',
  /** The session's root in the runtime; apps/api persists it as the durable pin. */
  'runtime_session',
  'turn_begin',
  'end',
] as const;
export type DaemonTurnStreamKind = (typeof DAEMON_TURN_STREAM_KINDS)[number];

/** A daemon `turn-stream` frame. Channel-content kinds (`step`, `answer`) carry more fields. */
export const TurnStreamRelayBodySchema = z
  .object({
    session_id: z.string(),
    kind: z.string(),
    /** The runtime's session id: the root, or a subagent child for `end`. */
    runtime_session_id: z.string().optional(),
    turn_message_id: z.string().optional(),
    turn_token: z.string().optional(),
    status: z.string().optional(),
    error_name: z.string().optional(),
    error_message: z.string().optional(),
    error_status: z.number().optional(),
    error_retryable: z.boolean().optional(),
    error_provider: z.string().optional(),
  })
  .passthrough();
export type TurnStreamRelayBody = z.infer<typeof TurnStreamRelayBodySchema>;

/** `POST /v1/projects/:projectId/turn-question`. */
export const TurnQuestionRelayBodySchema = z.object({
  session_id: z.string(),
  request_id: z.string(),
  runtime_session_id: z.string().optional(),
  questions: z.array(z.unknown()),
});
export type TurnQuestionRelayBody = z.infer<typeof TurnQuestionRelayBodySchema>;

/** `POST /v1/projects/:projectId/turn-permission`. apps/api reads `session_id` and `request_id`. */
export const TurnPermissionRelayBodySchema = z.object({
  session_id: z.string(),
  request_id: z.string(),
  runtime_session_id: z.string().optional(),
  permission: z.string(),
  patterns: z.array(z.string()),
});
export type TurnPermissionRelayBody = z.infer<typeof TurnPermissionRelayBodySchema>;

/** `POST /v1/platform/runtime-projection` (gzip). `projection` is the `/kortix/runtime/state` document. */
export const RuntimeProjectionRelayBodySchema = z.object({
  session_id: z.string(),
  captured_at: z.string().optional(),
  projection_etag: z.string().optional(),
  projection: z.record(z.string(), z.unknown()),
});
export type RuntimeProjectionRelayBody = z.infer<typeof RuntimeProjectionRelayBodySchema>;

/**
 * `POST /v1/projects/:projectId/sessions/:sessionId/audit/events`. `source`
 * and `harness` describe every event in the batch; a daemon built before them
 * sends neither, and its events are OpenCode's.
 */
export interface RuntimeAuditBatch {
  source?: 'runtime';
  harness?: string;
  events: unknown[];
}

/**
 * Rewrite the pre-W3 names an older daemon sends to the names above: the
 * `opencode_session_id` field and the `opencode_session` turn-stream kind.
 * Returns a copy; the neutral name wins when a body carries both.
 */
export function normalizeRuntimeRelayBody<T extends Record<string, unknown>>(
  body: T,
): T & { runtime_session_id?: string } {
  const { opencode_session_id: legacyId, ...rest } = body as Record<string, unknown>;
  const out = rest as Record<string, unknown>;
  if (out.runtime_session_id === undefined && typeof legacyId === 'string') {
    out.runtime_session_id = legacyId;
  }
  if (out.kind === 'opencode_session') out.kind = 'runtime_session';
  return out as T & { runtime_session_id?: string };
}

/**
 * What the session runtime supports, as `GET /kortix/health` lists it in
 * `capabilities` beside the host's own entries (`file.import`, ...). A client
 * hides a control whose capability is absent.
 */
export const RUNTIME_CAPABILITIES = [
  /** Revert to a message and restore it (`/session/:id/revert`, `/unrevert`). */
  'session.rewind',
  /** Summarize the conversation on demand (`/session/:id/summarize`). */
  'session.compact',
  /** Project slash commands (`GET /command`, `/session/:id/command`). */
  'session.commands',
  /** Fork a session at a message. */
  'session.fork',
  /** Subagent child sessions, readable while the parent drives them. */
  'session.subagents',
  /** MCP servers the runtime connects itself. */
  'session.mcp',
  /** The runtime's todo list (`/session/:id/todo`). */
  'session.todo',
  /** A shell command run as a turn (`/session/:id/shell`). */
  'session.shell',
  /** Attach the harness's own terminal client to the session runtime. */
  'session.attach',
] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

/** The closed `harness` block of `GET /kortix/health`. */
export const HarnessHealthSchema = z.object({
  /** `opencode` or `pi`. */
  id: z.string(),
  /** The harness release, when the daemon can tell. */
  version: z.string().nullable(),
  /** The runtime process state: `starting`, `ok`, `down` or `error`. */
  state: z.string(),
  /** The harness is ready for a prompt. `runtimeReady` adds the host's workspace checks. */
  ready: z.boolean(),
  /** Why the harness cannot serve, when it cannot. */
  error: z.string().nullable(),
  session: z.object({
    /** The session's root in the runtime. */
    id: z.string().nullable(),
    /** apps/api asked this box to create the root at boot. */
    required: z.boolean(),
  }),
  /** Present only for `?turn=1`. */
  turn: z
    .object({
      in_flight: z.boolean().nullable(),
      end: z.string().nullable(),
      orphaned_prompt: z.boolean(),
    })
    .nullable(),
  /** Harness-specific facts (OpenCode `pid`/`port`, pi `model`/`extensions`). */
  details: z.record(z.string(), z.unknown()),
});
export type HarnessHealth = z.infer<typeof HarnessHealthSchema>;

/**
 * The harness a health body names: the W3 `harness` block, the W0 string, or
 * null for an older daemon (which runs OpenCode).
 */
export function healthHarnessId(health: { harness?: unknown } | null | undefined): string | null {
  const harness = health?.harness;
  if (typeof harness === 'string') return harness;
  if (harness && typeof harness === 'object' && typeof (harness as { id?: unknown }).id === 'string') {
    return (harness as { id: string }).id;
  }
  return null;
}

/** The runtime process state a health body reports: the W3 `harness` block, or the pre-W3 `opencode` field. */
export function healthRuntimeState(health: Record<string, unknown> | null | undefined): string | null {
  const harness = health?.harness;
  if (harness && typeof harness === 'object' && typeof (harness as { state?: unknown }).state === 'string') {
    return (harness as { state: string }).state;
  }
  return typeof health?.opencode === 'string' ? health.opencode : null;
}

/** The port the runtime listens on (OpenCode's alternates on a verified reload): `harness.details.port`, or the pre-W3 `opencode_port`. */
export function healthRuntimePort(health: Record<string, unknown> | null | undefined): number | null {
  const harness = health?.harness;
  const details = harness && typeof harness === 'object' ? (harness as { details?: unknown }).details : null;
  const port = details && typeof details === 'object' ? (details as { port?: unknown }).port : health?.opencode_port;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null;
}
