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
  /**
   * The running turn read a steered message (`turn_message_id`) at a step
   * boundary. apps/api closes that message's inbox row as delivered.
   */
  'steer_read',
] as const;
export type DaemonTurnStreamKind = (typeof DAEMON_TURN_STREAM_KINDS)[number];

/**
 * A `turn-stream` frame. The daemon sends the lifecycle kinds above; the
 * in-sandbox channel CLI (`apps/sandbox/slack-cli`) sends the content kinds
 * `step` and `answer` with `text` and the fields after it.
 */
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
    /** The daemon's `TurnErrorCode` (`./transcript`). Absent from a daemon built before W5. */
    error_code: z.string().optional(),
    text: z.string().optional(),
    detail: z.string().optional(),
    output: z.string().optional(),
    sources: z.array(z.object({ url: z.string().optional(), text: z.string().optional() })).optional(),
    /** Slack Block Kit blocks. */
    blocks: z.array(z.unknown()).optional(),
    /** A Teams Adaptive Card. */
    card: z.record(z.string(), z.unknown()).optional(),
    /** A Teams form card. */
    form: z.record(z.string(), z.unknown()).optional(),
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
 * One sanitized runtime event in an audit batch: identity, digests and
 * redacted summaries, never raw tool input or output. apps/api validates each
 * field itself and rejects the batch with the failing index.
 */
export const RuntimeAuditEventSchema = z.object({
  /** sha256 hex of the event's identity. */
  event_id: z.string(),
  /** Stable identity for one observed emission. Retries preserve it. */
  source_revision: z.string(),
  type: z.string(),
  occurred_at: z.string(),
  runtime_session_id: z.string().nullable(),
  turn_id: z.string().nullable(),
  message_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  execution_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  correlation_id: z.string().nullable(),
  causation_id: z.string().nullable(),
  delegation_depth: z.number().int(),
  outcome: z.enum(['success', 'failure', 'denied', 'pending']),
  phase: z.string(),
  input_summary: z.record(z.string(), z.unknown()),
  output_summary: z.record(z.string(), z.unknown()).nullable(),
  input_sha256: z.string(),
  output_sha256: z.string().nullable(),
  error_code: z.string().nullable(),
  /** apps/api never stores it: an error string can carry a prompt. */
  error_message: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type RuntimeAuditEvent = z.infer<typeof RuntimeAuditEventSchema>;

/**
 * `POST /v1/projects/:projectId/sessions/:sessionId/audit/events`. `source`
 * and `harness` describe every event in the batch; a daemon built before them
 * sends neither, and its events are OpenCode's.
 */
export const RuntimeAuditBatchSchema = z.object({
  source: z.literal('runtime').optional(),
  harness: z.string().optional(),
  events: z.array(RuntimeAuditEventSchema),
});
export type RuntimeAuditBatch = z.infer<typeof RuntimeAuditBatchSchema>;

/** One boot milestone: a label and the ms since the daemon booted (`main.ts` `bootTime`). */
export const BootMarkSchema = z.object({ label: z.string(), atMs: z.number() });
export type BootMark = z.infer<typeof BootMarkSchema>;

/** `POST /v1/platform/boot-timeline`, once per boot when the runtime is first ready. */
export const BootTimelineRelayBodySchema = z.object({
  session_id: z.string(),
  timeline: z.array(BootMarkSchema),
});
export type BootTimelineRelayBody = z.infer<typeof BootTimelineRelayBodySchema>;

/** Longest monitor ingest batch one POST may carry. */
export const MONITOR_INGEST_MAX_EVENTS = 50;
/** Longest serialized monitor line apps/api stores; longer lines truncate with a marker. */
export const MONITOR_LINE_MAX_BYTES = 8 * 1024;
export const MONITOR_EVENT_KINDS = ['event', 'lifecycle'] as const;
export type MonitorEventKind = (typeof MONITOR_EVENT_KINDS)[number];

/** One monitor output line in an ingest batch. `seq` restarts per `box_epoch`. */
export const MonitorWireEventSchema = z.object({
  slug: z.string(),
  seq: z.number().int().nonnegative(),
  kind: z.enum(MONITOR_EVENT_KINDS),
  /** The parsed JSON line, or `{ raw: "<line>" }` when it does not parse. */
  line: z.record(z.string(), z.unknown()),
  emitted_at: z.string(),
});
export type MonitorWireEvent = z.infer<typeof MonitorWireEventSchema>;

/** `POST /v1/projects/:projectId/monitors/ingest`, from the project's monitor box. */
export const MonitorIngestRelayBodySchema = z.object({
  /** This boot of the monitor runner. A superseded epoch answers 409. */
  box_epoch: z.string(),
  events: z.array(MonitorWireEventSchema).max(MONITOR_INGEST_MAX_EVENTS),
});
export type MonitorIngestRelayBody = z.infer<typeof MonitorIngestRelayBodySchema>;

/** The daemon's 404 body for a `/kortix/*` route it does not serve. apps/api maps it to 501 on share links. */
export const UNKNOWN_DAEMON_ROUTE_ERROR = 'unknown kortix route';

/**
 * How long the daemon's `POST /file/import` may download, fsync and rename
 * before it aborts. The API proxy gives an import attempt more than this, so
 * the daemon always answers first.
 */
export const DAEMON_FILE_IMPORT_TIMEOUT_MS = 120_000;

/**
 * The runtime REST routes (`POST /session/:id/<verb>`) whose response waits for
 * the whole turn. The daemon proxy and the API proxy give them the long bound;
 * a short one aborts a turn that is still computing.
 */
export const BLOCKING_TURN_VERBS = ['message', 'command', 'summarize'] as const;

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
 * `code` on the daemon's 503 while the session runtime cannot take a request:
 * the repo is not on disk, the workspace is installing, or the harness is still
 * starting. A client renders it as "starting" and retries. The `error` text
 * beside it differs per harness and predates the code.
 */
export const RUNTIME_NOT_READY_CODE = 'runtime_not_ready' as const;

/** The daemon names its boot phase in this header on every not-ready 503. */
export const BOOT_PHASE_HEADER = 'x-kortix-boot-phase';

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
  /** A runtime config document a client may read and patch (`/global/config`). */
  'session.config',
  /**
   * A message sent during a turn is read by that turn at its next step
   * boundary (`POST /kortix/runtime/sessions/:id/steer`). The turn does not stop.
   */
  'session.steer',
] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

/**
 * The daemon serves the Kortix turn verbs: `POST /kortix/runtime/sessions/:id/prompt`,
 * `POST /kortix/runtime/sessions/:id/abort`, `GET|DELETE /kortix/runtime/messages/:id/:messageId`
 * and `GET /kortix/runtime/agents`. Listed in `capabilities` beside the runtime's own.
 */
export const RUNTIME_TURNS_CAPABILITY = 'runtime.turns.v1' as const;

/**
 * The daemon serves `POST /kortix/runtime/messages/:id/:messageId/retract`:
 * take back a user message that no model call has read, on every harness.
 * `200 { retracted: true }` when it is gone, `404` when there is no such
 * message, `409 { code: MESSAGE_READ_CODE }` when a model call read it.
 */
export const RUNTIME_RETRACT_CAPABILITY = 'runtime.retract.v1' as const;

/**
 * `code` on the daemon's `409` to a retract: a model call read the message
 * (its turn runs or ran), so it stays where it is.
 */
export const MESSAGE_READ_CODE = 'message_read' as const;

/**
 * `code` on the daemon's `409` to `POST /kortix/runtime/sessions/:id/steer`:
 * no turn is running, so nothing can read the message. The caller sends it as
 * a prompt instead.
 */
export const STEER_NO_ACTIVE_TURN_CODE = 'no_active_turn' as const;

/** The `schema` of the `/kortix/runtime/state` document. */
export const KORTIX_RUNTIME_SCHEMA = 'kortix.runtime.v1' as const;

/** The `identity` block of the `/kortix/runtime/state` document. */
export interface RuntimeStateIdentity {
  /** The session's root in the runtime. */
  runtime_session_id: string | null;
  /** `opencode` or `pi`. */
  harness: string;
  /** The harness release, when the daemon can tell. */
  harness_version: string | null;
}

/**
 * One agent of the compiled agent set apps/api sends a session
 * (`KORTIX_AGENT_CONFIG`). The keys keep OpenCode's `AgentConfig` spelling,
 * which every live daemon reads; the comments give the Kortix meaning.
 */
export interface CompiledAgent {
  description?: string;
  /** Role: `primary` runs a session, `subagent` runs under `task`, `all` both. */
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  /** Reasoning effort. */
  variant?: string;
  /** Sampling. */
  temperature?: number;
  /** Sampling. */
  top_p?: number;
  /** The system prompt: the agent's `.md` body. */
  prompt?: string;
  /** Visibility: the agent cannot run. */
  disable?: boolean;
  /** Visibility: the agent runs but pickers do not list it. */
  hidden?: boolean;
  /** Provider options, passed through as they are. */
  options?: Record<string, unknown>;
  color?: string;
  /** Maximum model steps per turn. */
  steps?: number;
  /**
   * Tool access, by tool name: `false` hides the tool, `true` shows it, and
   * `*` holds the answer for every tool not named. Omitted: every tool. Read
   * it with `toolAllowed`.
   */
  tools?: Record<string, boolean>;
  /** Tool policy: capability → action, or capability → pattern → action. */
  permission?: unknown;
}

/** The compiled agent set of a session. */
export interface CompiledAgentSet {
  /** The default agent's model, for a session that picked no agent. */
  model?: string;
  small_model?: string;
  /** The agent a session with no agent chosen runs. */
  default_agent?: string;
  agent: Record<string, CompiledAgent>;
  /**
   * The project's tools (kortix.yaml `tools`): tool name → repo-relative path
   * of its module. Every harness loads them through the daemon's tool host.
   */
  project_tools?: Record<string, string>;
  /**
   * The Kortix tools the project lists as `<name>: kortix:<name>`. Present
   * only when kortix.yaml has a `tools` key; then only these Kortix tools load,
   * plus the ones `project_tools` replaces. Absent: all of them load.
   */
  kortix_tools?: string[];
}

/** May an agent with this compiled `tools` map use `tool`? Its own entry, else `*`, else yes. */
export function toolAllowed(tools: Record<string, boolean> | undefined, tool: string): boolean {
  if (!tools) return true;
  if (Object.hasOwn(tools, tool)) return tools[tool] !== false;
  return !Object.hasOwn(tools, '*') || tools['*'] !== false;
}

/** The agent settings a harness applies. A setting a harness does not list is ignored there. */
export const AGENT_SETTING_HARNESSES = {
  description: ['opencode', 'pi'],
  mode: ['opencode', 'pi'],
  model: ['opencode', 'pi'],
  variant: ['opencode', 'pi'],
  temperature: ['opencode', 'pi'],
  top_p: ['opencode', 'pi'],
  options: ['opencode'],
  color: ['opencode'],
  steps: ['opencode', 'pi'],
  tools: ['opencode', 'pi'],
  hidden: ['opencode', 'pi'],
  permission: ['opencode', 'pi'],
  disable: ['opencode', 'pi'],
  prompt: ['opencode', 'pi'],
} as const satisfies Record<keyof CompiledAgent, readonly ('opencode' | 'pi')[]>;
export type AgentSetting = keyof typeof AGENT_SETTING_HARNESSES;

/** The agent settings `harness` ignores, in `AGENT_SETTING_HARNESSES` order. */
export function ignoredAgentSettings(harness: string): AgentSetting[] {
  return (Object.keys(AGENT_SETTING_HARNESSES) as AgentSetting[]).filter(
    (setting) => !(AGENT_SETTING_HARNESSES[setting] as readonly string[]).includes(harness),
  );
}

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
