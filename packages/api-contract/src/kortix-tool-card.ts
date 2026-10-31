/**
 * The output of a My Kortix platform tool (`kortix_agents`, `kortix_sessions`,
 * `kortix_schedules`, `kortix_connectors`, `kortix_people`,
 * `kortix_access`, `kortix_usage`, `kortix_change_requests`, `kortix_memory`): one JSON object, the tool's whole text
 * output. The model reads `data` and `error`; the web client renders `card`
 * (`packages/ui/src/session/tool/tools/kortix-action-tool.tsx` parses this
 * shape defensively, because it does not depend on this package).
 *
 * An `href` is an in-app path (`/projects/<id>/…`) that the client resolves
 * against its own origin, or, only in `card.links`, an absolute `https://` URL
 * (a connector sign-in) that the client opens in a new tab.
 */
export const KORTIX_PLATFORM_TOOL_NAMES = [
  'kortix_agents',
  'kortix_sessions',
  'kortix_schedules',
  'kortix_connectors',
  'kortix_people',
  'kortix_access',
  'kortix_usage',
  'kortix_change_requests',
  // What My Kortix remembers about the person (apps/kortix-sandbox-agent-server/src/services/tools/platform/kortix_memory.ts).
  'kortix_memory',
] as const;
export type KortixPlatformToolName = (typeof KORTIX_PLATFORM_TOOL_NAMES)[number];

/** The state a card shows. `needs_you`: the person must act (approve, click a link, answer). */
export type KortixCardStatus = 'done' | 'running' | 'needs_you' | 'denied' | 'error';

export interface KortixCardRow {
  /** The row's main text: an agent name, a session title, a person. */
  title: string;
  /** One short line under it. */
  detail?: string;
  /** A short state word the client shows as a badge ("running", "paused", "admin"). */
  badge?: string;
  /** In-app path the row opens. */
  href?: string;
}

/** One changed setting: what it was and what it is now. A `before` of `null` is a new setting. */
export interface KortixCardChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface KortixCardLink {
  label: string;
  href: string;
}

export interface KortixToolCard {
  /** The headline, in plain words: "3 agents", "Created the Researcher agent". */
  title: string;
  subtitle?: string;
  status: KortixCardStatus;
  rows?: KortixCardRow[];
  changes?: KortixCardChange[];
  links?: KortixCardLink[];
}

/** Who can grant a refused action, by display name. */
export interface KortixGrantor {
  name: string;
  role: string;
}

export interface KortixToolError {
  /** `denied`: the person lacks the permission. `not_found`, `invalid`: the input. `failed`: anything else. */
  kind: 'denied' | 'not_found' | 'invalid' | 'failed';
  message: string;
  /** For `denied`: the people who can grant it, when the tool could read them. */
  grantors?: KortixGrantor[];
}

export interface KortixToolResult {
  ok: boolean;
  tool: KortixPlatformToolName;
  action: string;
  card: KortixToolCard;
  data?: unknown;
  error?: KortixToolError;
}

/**
 * The `workflow` tool's part metadata (pi tool `details`): pushed live with
 * every change while the run goes on, and final when the call returns. The web
 * client's workflow card renders it (`packages/ui/src/session/tool/tools/workflow-tool.tsx`).
 */
export type WorkflowRunStatus = 'running' | 'done' | 'failed' | 'stopped';
export type WorkflowAgentStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped';

export interface WorkflowRunPhase {
  title: string;
  /** `pending`: declared in the script's `meta.phases`, not started yet. */
  status: WorkflowRunStatus | 'pending';
}

export interface WorkflowRunAgent {
  /** Stable per run: `a1`, `a2`, … in start order. */
  id: string;
  /** What this agent does, in a few words (`agent(prompt, { label })`, else the prompt's first line). */
  label: string;
  /** The project agent it runs as, when the script named one. */
  agent?: string;
  /** The phase that was current when it started. */
  phase?: string;
  status: WorkflowAgentStatus;
  /** The child Kortix session, once it exists. */
  sessionId?: string;
  /** The first line of its answer, or of its error. */
  summary?: string;
  /** Resumed run: this agent's saved result from the earlier run was reused; no session started. */
  cached?: true;
  /** The model the script asked for (`agent(p, { model })`); absent = the agent's own. */
  model?: string;
  /** `agent(p, { schema })`: the answer is JSON checked against the schema. */
  structured?: true;
  /** 1 for the first attempt; a stalled agent restarts with the same prompt (Claude: `(retry n)`). */
  attempt?: number;
  /** Epoch ms. */
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowRunMetadata {
  runId: string;
  title: string;
  status: WorkflowRunStatus;
  phases: WorkflowRunPhase[];
  agents: WorkflowRunAgent[];
  startedAt: number;
  endedAt?: number;
  error?: string;
  /** The most agents this run may start: what the person approved, else the tool's limit. */
  maxAgents?: number;
  /** A saved workflow run by name (`meta.name`). */
  name?: string;
  /** The script's newest `log()` lines, oldest first (at most 5). */
  logs?: string[];
  /** More than `WORKFLOW_LARGE_AGENT_COUNT` (25) agents planned or started: the card warns, as Claude Code's "Large workflow". */
  large?: true;
  /** The run this one resumed (`resume_run_id`): its completed agents' results were reused. */
  resumedFrom?: string;
  /**
   * `background: true`: the run goes on in its own runner session (a child of
   * this one), and this call returned at once. The runner session holds the
   * live run; its answer arrives here as a notification when the run ends.
   */
  background?: { sessionId: string };
  /**
   * The person paused the run (`POST /kortix/runtime/workflows/:runId/control`
   * `pause`): no new agent starts until `resume`; running agents finish.
   */
  paused?: boolean;
}
