// ─── Unified Trigger System Types ────────────────────────────────────────────

export type SourceType = "cron" | "webhook"
export type ActionType = "prompt" | "command" | "http" | "ticket_create"
export type ExecutionStatus = "running" | "completed" | "failed" | "skipped"

// ─── Trigger Record (DB row) ────────────────────────────────────────────────

export interface TriggerRecord {
  id: string
  name: string
  description: string | null

  // Source
  source_type: SourceType
  source_config: string // JSON

  // Action
  action_type: ActionType
  action_config: string // JSON

  // Context extraction (for prompt actions with webhook payloads)
  context_config: string // JSON

  // Prompt-action shorthand (denormalized)
  agent_name: string | null
  model_id: string | null
  session_mode: string // "new" | "reuse"
  session_id: string | null

  // Pipedream metadata
  pipedream_app: string | null
  pipedream_component: string | null
  pipedream_deployed_id: string | null
  pipedream_webhook_url: string | null
  pipedream_props: string // JSON

  // Runtime state (DB only)
  is_active: number // SQLite boolean
  last_run_at: string | null
  next_run_at: string | null
  last_event_at: string | null
  event_count: number

  metadata: string // JSON
  created_at: string
  updated_at: string
}

// ─── Execution Record (DB row) ──────────────────────────────────────────────

export interface ExecutionRecord {
  id: string
  trigger_id: string
  status: ExecutionStatus
  session_id: string | null
  error_message: string | null
  stdout: string | null
  stderr: string | null
  exit_code: number | null
  http_status: number | null
  http_body: string | null
  retry_count: number
  metadata: string // JSON
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  created_at: string
}

// ─── Source Configs (parsed from JSON) ──────────────────────────────────────

export interface CronSourceConfig {
  cron_expr: string
  timezone?: string
}

export interface WebhookSourceConfig {
  path: string
  method?: string
  secret?: string
}

// ─── Action Configs (parsed from JSON) ──────────────────────────────────────

export interface PromptActionConfig {
  prompt: string
  agent?: string
  model?: string
  session_mode?: "new" | "reuse"
}

export interface CommandActionConfig {
  command: string
  args?: string[]
  workdir?: string
  env?: Record<string, string>
  timeout_ms?: number
}

export interface HttpActionConfig {
  url: string
  method?: string
  headers?: Record<string, string>
  body_template?: string
  timeout_ms?: number
}

/**
 * Ticket-create action — fires when the trigger source fires (cron tick,
 * webhook POST, manual run) and creates a ticket in the trigger's project
 * via ticket-service.createTicket. Title/body templates render against
 * event.data (webhook payloads) or the event envelope (cron).
 *
 * Team routing: `assignee_slugs` (comma-separated during YAML/API ingestion,
 * array after parse) resolves to agent IDs at dispatch time. If empty, the
 * ticket's landing column's default_assignee rules fire.
 */
export interface TicketCreateActionConfig {
  title: string
  body_md?: string
  template_id?: string
  /** Column key (e.g. "backlog", "in_progress"). Default: first column. */
  column?: string
  /** Agent slugs to tag. Empty = let the column's default_assignee rule fire. */
  assignee_slugs?: string[]
}

// ─── Context Config ─────────────────────────────────────────────────────────

export interface ContextConfig {
  extract?: Record<string, string>
  include_raw?: boolean
  /** Template for session reuse key, rendered with extracted values.
   *  E.g. "telegram:user:{{ user_id }}" → per-user sessions.
   *  Falls back to "trigger:{name}" when unset. */
  session_key?: string
}

// ─── Pipedream Config (from YAML) ───────────────────────────────────────────

export interface PipedreamConfig {
  app: string
  component_key: string
  configured_props?: Record<string, unknown>
}

// ─── YAML trigger entry ─────────────────────────────────────────────────────

export interface YamlTriggerEntry {
  name: string
  description?: string
  source: {
    type: SourceType
    // cron fields
    cron_expr?: string
    timezone?: string
    // webhook fields
    path?: string
    method?: string
    secret?: string
  }
  action: {
    type?: ActionType // default: prompt
    // prompt fields
    prompt?: string
    agent?: string
    model?: string
    session_mode?: string
    // command fields
    command?: string
    args?: string[]
    workdir?: string
    env?: Record<string, string>
    timeout_ms?: number
    // http fields
    url?: string
    method?: string
    headers?: Record<string, string>
    body_template?: string
    // ticket_create fields
    title?: string
    body_md?: string
    template_id?: string
    column?: string
    assignee_slugs?: string[]
  }
  context?: ContextConfig
  pipedream?: PipedreamConfig
}

export interface TriggersYamlFile {
  triggers: YamlTriggerEntry[]
}

// ─── API types ──────────────────────────────────────────────────────────────

export interface TriggerResponse {
  id: string
  name: string
  description: string | null
  source_type: SourceType
  source_config: Record<string, unknown>
  action_type: ActionType
  action_config: Record<string, unknown>
  context_config: Record<string, unknown>
  agent_name: string | null
  model_id: string | null
  session_mode: string
  session_id: string | null
  pipedream: {
    app: string | null
    component: string | null
    deployed_id: string | null
    webhook_url: string | null
    props: Record<string, unknown>
  } | null
  is_active: boolean
  last_run_at: string | null
  next_run_at: string | null
  last_event_at: string | null
  event_count: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  // Compat fields for frontend
  triggerId: string
  type: string
  sourceType: string
  prompt: string
  enabled: boolean
  isActive: boolean
  editable: boolean
  cronExpr: string | null
  timezone: string | null
  nextRunAt: string | null
  lastRunAt: string | null
  sessionMode: string
  agentName: string | null
  modelId: string | null
  modelProviderId: string | null
  webhook: { path: string; method: string; secretProtected: boolean } | null
  agentFilePath: string | null
  maxRetries: number
  timeoutMs: number
  project_id: string | null
  /** Optional ticket this trigger is bound to. Each fire reuses a per-ticket
   * session (session_key=`ticket:<id>`) so the agent has continuity. */
  ticket_id: string | null
}

export interface ExecutionResponse {
  executionId: string
  triggerId: string
  status: ExecutionStatus
  sessionId: string | null
  errorMessage: string | null
  stdout: string | null
  stderr: string | null
  exitCode: number | null
  httpStatus: number | null
  retryCount: number
  metadata: Record<string, unknown>
  startedAt: string
  completedAt: string | null
  durationMs: number | null
  createdAt: string
  trigger_name?: string
}

// ─── Plugin types ───────────────────────────────────────────────────────────

export interface TriggerPluginOptions {
  directory?: string
  homeDir?: string
  webhookPort?: number
  webhookHost?: string
  publicBaseUrl?: string
  autoSync?: boolean
  logger?: (level: "info" | "warn" | "error", message: string) => void
}

export interface MinimalOpenCodeClient {
  app?: {
    log?: (input: { body: { service: string; level: string; message: string } }) => Promise<unknown>
  }
  session: {
    create: (parameters?: { body?: { directory?: string; title?: string } }) => Promise<{ data?: { id: string } } | { id: string }>
    promptAsync: (parameters: {
      path?: { id: string }
      query?: { directory?: string }
      body?: {
        agent?: string
        model?: { providerID: string; modelID: string }
        parts: Array<{ type: "text"; text: string }>
      }
    }) => Promise<unknown>
  }
}

export interface PluginContextShape {
  client: MinimalOpenCodeClient
  directory?: string
}

// ─── Legacy compat types (kept for backward compat exports) ─────────────────

/** @deprecated Use SourceType instead */
export type TriggerKind = "cron" | "webhook" | "pipedream"

export interface TriggerExecutionConfig {
  prompt: string
  agentName?: string
  modelId?: string
  sessionMode?: "new" | "reuse"
}

export interface TriggerContextConfig {
  extract?: Record<string, string>
  includeRaw?: boolean
}

export interface TriggerBase {
  name: string
  enabled?: boolean
  execution: TriggerExecutionConfig
  context?: TriggerContextConfig
}

export interface CronTriggerConfig extends TriggerBase {
  source: { type: "cron"; expr: string; timezone?: string }
}

export interface WebhookTriggerConfig extends TriggerBase {
  source: { type: "webhook"; path: string; method?: string; secret?: string }
}

export interface PipedreamSourceConfig {
  type: "pipedream"
  componentKey: string
  app: string
  configuredProps?: Record<string, unknown>
}

export interface PipedreamTriggerConfig extends TriggerBase {
  source: PipedreamSourceConfig
}

export type AgentTriggerConfig = CronTriggerConfig | WebhookTriggerConfig | PipedreamTriggerConfig

export interface DiscoveredAgent {
  name: string
  filePath: string
  triggers: AgentTriggerConfig[]
}

export interface CronTriggerRecord {
  id?: string
  name: string
  cron_expr: string
  prompt: string
  timezone?: string
  agent_name?: string | null
  model_id?: string
  source?: string
  session_mode?: string
  is_active?: boolean
  last_run_at?: string | null
  next_run_at?: string | null
  session_id?: string | null
  metadata?: Record<string, unknown>
}

export type CronExecutionStatus = "running" | "completed" | "failed" | "skipped"

export interface CronExecutionRecord {
  execution_id: string
  trigger_id: string
  status: CronExecutionStatus
  session_id?: string | null
  error_message?: string | null
  retry_count: number
  metadata: Record<string, unknown>
  created_at: string
  started_at: string
  completed_at?: string | null
  duration_ms?: number | null
}

export interface TriggerSyncResult {
  total: number
  created: number
  updated: number
  removed: number
  details: string[]
}

export interface AgentTriggersPluginOptions {
  agentPaths?: string[]
  listenerStatePath?: string
  webhookPort?: number
  webhookHost?: string
  publicBaseUrl?: string
  autoSync?: boolean
  syncDelayMs?: number
  directory?: string
  homeDir?: string
  logger?: (level: "info" | "warn" | "error", message: string) => void
}

export interface EventListenerRecord {
  id: string
  name: string
  agentName: string
  app: string
  componentKey: string
  deployedTriggerId: string
  configuredProps?: Record<string, unknown>
  prompt: string
  context?: TriggerContextConfig
  sessionMode?: "new" | "reuse"
  executionAgentName?: string
  modelId?: string
  isActive: boolean
  source: string
  externalUserId: string
  webhookUrl: string
  createdAt: string
  updatedAt: string
  lastEventAt?: string | null
  eventCount: number
}

export interface WebhookDispatchResult {
  sessionId: string
}
