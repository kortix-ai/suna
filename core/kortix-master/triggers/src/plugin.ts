/**
 * Unified Triggers Plugin — Exposes a single `triggers` tool
 * plus backward-compat aliases for cron_triggers, event_triggers, agent_triggers, sync_agent_triggers.
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import { TriggerManager } from "./trigger-manager.js"
import type { TriggerPluginOptions, PluginContextShape, TriggerRecord } from "./types.js"
import { describeCron } from "./trigger-store.js"

type TriggerManagerRegistry = Map<string, TriggerManager>

function getTriggerManagerRegistry(): TriggerManagerRegistry {
  const g = globalThis as typeof globalThis & { __kortixTriggerManagers?: TriggerManagerRegistry }
  if (!g.__kortixTriggerManagers) g.__kortixTriggerManagers = new Map()
  return g.__kortixTriggerManagers
}

function createLogger(client: PluginContextShape["client"], fallback?: TriggerPluginOptions["logger"]) {
  return (level: "info" | "warn" | "error", message: string) => {
    fallback?.(level, message)
    try {
      client.app?.log?.({ body: { service: "kortix-triggers", level, message } }).catch(() => undefined)
    } catch {}
  }
}

function formatTriggerForDisplay(t: TriggerRecord): string {
  const sc = JSON.parse(t.source_config) as Record<string, unknown>
  const ac = JSON.parse(t.action_config) as Record<string, unknown>
  const status = t.is_active ? "active" : "paused"
  const sourceInfo = t.source_type === "cron"
    ? `cron: ${sc.cron_expr} (${describeCron(String(sc.cron_expr))})`
    : `webhook: ${sc.method ?? "POST"} ${sc.path}`
  const actionInfo = t.action_type === "prompt"
    ? `prompt → ${t.agent_name ?? "default"}`
    : t.action_type === "command"
    ? `command: ${ac.command}`
    : `http: ${ac.method ?? "POST"} ${ac.url}`

  return `[${status}] ${t.name} | ${sourceInfo} | ${actionInfo} | last_run: ${t.last_run_at ?? "never"}`
}

export function createTriggersPlugin(options: TriggerPluginOptions = {}): Plugin {
  const plugin: Plugin = async (ctx) => {
    const shaped = ctx as unknown as PluginContextShape
    const logger = createLogger(shaped.client, options.logger)
    const normalizedOptions = {
      ...options,
      directory: options.directory ?? shaped.directory,
      logger,
    }
    const registryKey = `${normalizedOptions.directory ?? process.cwd()}::${normalizedOptions.webhookHost ?? "0.0.0.0"}:${normalizedOptions.webhookPort ?? 8099}`
    const registry = getTriggerManagerRegistry()
    let manager = registry.get(registryKey)
    if (!manager) {
      manager = new TriggerManager(shaped.client, normalizedOptions)
      registry.set(registryKey, manager)
    }

    if (options.autoSync !== false) await manager.start()

    return {
      tool: {
        // ─── Unified triggers tool ────────────────────────────────────────
        triggers: tool({
          description: `Manage triggers (cron schedules, webhooks) with actions (prompt AI agent, run command, call HTTP).

Actions:
- list: List all triggers. Optional: source_type (cron|webhook), is_active (true|false)
- create: Create trigger. Required: name, source_type. For cron: cron_expr. For webhook: path. For prompt action: prompt. For command action: command. For http action: url.
- get: Get trigger detail. Required: trigger_id
- update: Update trigger. Required: trigger_id. Optional: any create fields.
- delete: Delete trigger. Required: trigger_id
- pause: Pause trigger. Required: trigger_id
- resume: Resume trigger. Required: trigger_id
- run: Fire trigger manually now. Required: trigger_id
- executions: List execution history. Required: trigger_id
- sync: Force re-read triggers.yaml into DB

Examples:
  triggers action=list
  triggers action=create name="Daily Report" source_type=cron cron_expr="0 0 9 * * *" action_type=prompt prompt="Generate the daily report" agent_name=kortix
  triggers action=create name="Backup" source_type=cron cron_expr="0 0 2 * * *" action_type=command command="bash" args='["-c","./scripts/backup.sh"]'
  triggers action=create name="Deploy Hook" source_type=webhook path="/hooks/deploy" action_type=prompt prompt="Handle deploy" secret=mysecret
  triggers action=run trigger_id=xxx
  triggers action=pause trigger_id=xxx`,
          args: {
            action: tool.schema.string(),
            trigger_id: tool.schema.string().optional(),
            name: tool.schema.string().optional(),
            description: tool.schema.string().optional(),
            source_type: tool.schema.string().optional(),
            cron_expr: tool.schema.string().optional(),
            timezone: tool.schema.string().optional(),
            path: tool.schema.string().optional(),
            method: tool.schema.string().optional(),
            secret: tool.schema.string().optional(),
            action_type: tool.schema.string().optional(),
            prompt: tool.schema.string().optional(),
            agent_name: tool.schema.string().optional(),
            model_id: tool.schema.string().optional(),
            session_mode: tool.schema.string().optional(),
            command: tool.schema.string().optional(),
            args: tool.schema.string().optional(),
            workdir: tool.schema.string().optional(),
            url: tool.schema.string().optional(),
            body_template: tool.schema.string().optional(),
            timeout_ms: tool.schema.number().optional(),
            is_active: tool.schema.string().optional(),
            project_id: tool.schema.string().optional(),
            ticket_id: tool.schema.string().optional(),
            // action_type="ticket_create" args
            ticket_title: tool.schema.string().optional(),
            ticket_body: tool.schema.string().optional(),
            ticket_template_id: tool.schema.string().optional(),
            ticket_column: tool.schema.string().optional(),
            ticket_assignees: tool.schema.string().optional().describe('Comma-separated agent slugs, e.g. "engineer,qa".'),
          },
          async execute(args, toolCtx) {
            try {
              const store = manager.getStore()

              // Auto-stamp project_id from the session's bound project when
              // the caller (a per-project agent, typically PM) forgets to
              // pass it. Prevents "orphan" triggers that don't show up in
              // any project's Triggers tab even though they were created
              // inside a project session.
              if (!args.project_id && toolCtx?.sessionID) {
                try {
                  const row = (store as any).db
                    ?.query?.('SELECT project_id FROM session_projects WHERE session_id = ?')
                    .get(toolCtx.sessionID) as { project_id?: string } | null
                  if (row?.project_id) args.project_id = row.project_id
                } catch { /* best-effort — missing table or row is fine */ }
              }

              switch (args.action) {
                case "list": {
                  const filter: { source_type?: string; is_active?: boolean } = {}
                  if (args.source_type) filter.source_type = args.source_type
                  if (args.is_active === "true") filter.is_active = true
                  if (args.is_active === "false") filter.is_active = false
                  const triggers = store.list(filter)
                  if (triggers.length === 0) return "No triggers configured."
                  const lines = [`=== TRIGGERS (${triggers.length}) ===`, ""]
                  for (const t of triggers) lines.push(formatTriggerForDisplay(t))
                  return lines.join("\n")
                }

                case "create": {
                  if (!args.name) return "Error: name is required."
                  if (!args.source_type) return "Error: source_type is required (cron or webhook)."

                  const sourceConfig: Record<string, unknown> = {}
                  if (args.source_type === "cron") {
                    if (!args.cron_expr) return "Error: cron_expr is required for cron triggers."
                    sourceConfig.cron_expr = args.cron_expr
                    sourceConfig.timezone = args.timezone ?? "UTC"
                  } else if (args.source_type === "webhook") {
                    if (!args.path) return "Error: path is required for webhook triggers."
                    sourceConfig.path = args.path
                    sourceConfig.method = args.method ?? "POST"
                    if (args.secret) sourceConfig.secret = args.secret
                  } else {
                    return "Error: source_type must be 'cron' or 'webhook'."
                  }

                  const actionType = args.action_type ?? "prompt"
                  const actionConfig: Record<string, unknown> = {}
                  if (actionType === "prompt") {
                    if (!args.prompt) return "Error: prompt is required for prompt actions."
                    actionConfig.prompt = args.prompt
                  } else if (actionType === "command") {
                    if (!args.command) return "Error: command is required for command actions."
                    actionConfig.command = args.command
                    if (args.args) {
                      try { actionConfig.args = JSON.parse(args.args) } catch { return "Error: args must be valid JSON array." }
                    }
                    if (args.workdir) actionConfig.workdir = args.workdir
                    if (args.timeout_ms) actionConfig.timeout_ms = args.timeout_ms
                  } else if (actionType === "http") {
                    if (!args.url) return "Error: url is required for http actions."
                    actionConfig.url = args.url
                    if (args.method) actionConfig.method = args.method
                    if (args.body_template) actionConfig.body_template = args.body_template
                    if (args.timeout_ms) actionConfig.timeout_ms = args.timeout_ms
                  } else if (actionType === "ticket_create") {
                    if (!args.ticket_title) return "Error: ticket_title is required for ticket_create actions."
                    if (!args.project_id) return "Error: project_id is required for ticket_create (the ticket's target project)."
                    actionConfig.title = args.ticket_title
                    if (args.ticket_body) actionConfig.body_md = args.ticket_body
                    if (args.ticket_template_id) actionConfig.template_id = args.ticket_template_id
                    if (args.ticket_column) actionConfig.column = args.ticket_column
                    if (args.ticket_assignees) {
                      actionConfig.assignee_slugs = args.ticket_assignees
                        .split(",").map((s: string) => s.trim()).filter(Boolean)
                    }
                  } else {
                    return "Error: action_type must be 'prompt', 'command', 'http', or 'ticket_create'."
                  }

                  const trigger = manager.createTrigger({
                    name: args.name,
                    description: args.description,
                    source_type: args.source_type,
                    source_config: sourceConfig,
                    action_type: actionType,
                    action_config: actionConfig,
                    agent_name: args.agent_name,
                    model_id: args.model_id,
                    session_mode: args.session_mode,
                  })

                  // Optional scoping columns — stamped via direct SQL so the
                  // engine stays unaware of these additive fields. The web UI
                  // reads them to filter the Triggers tab by project and to
                  // render per-ticket links on rows + detail drawers.
                  if (args.project_id || args.ticket_id) {
                    try {
                      ;(store as any).db?.exec?.(
                        `ALTER TABLE triggers ADD COLUMN project_id TEXT`,
                      )
                    } catch {}
                    try {
                      ;(store as any).db?.exec?.(
                        `ALTER TABLE triggers ADD COLUMN ticket_id TEXT`,
                      )
                    } catch {}
                    if (args.project_id) {
                      try {
                        ;(store as any).db
                          ?.query?.(`UPDATE triggers SET project_id = ? WHERE id = ?`)
                          .run(args.project_id, trigger.id)
                      } catch {}
                    }
                    if (args.ticket_id) {
                      try {
                        ;(store as any).db
                          ?.query?.(`UPDATE triggers SET ticket_id = ? WHERE id = ?`)
                          .run(args.ticket_id, trigger.id)
                      } catch {}
                    }
                  }
                  return `Trigger created: ${trigger.name} (${trigger.id})\n${formatTriggerForDisplay(trigger)}`
                }

                case "get": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const trigger = store.get(args.trigger_id) ?? store.getByName(args.trigger_id)
                  if (!trigger) return `Error: Trigger not found: ${args.trigger_id}`
                  return JSON.stringify(trigger, null, 2)
                }

                case "update": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const patch: any = {}
                  if (args.name) patch.name = args.name
                  if (args.description !== undefined) patch.description = args.description
                  if (args.cron_expr || args.timezone || args.path || args.method || args.secret) {
                    const current = store.get(args.trigger_id)
                    if (current) {
                      const currentSc = JSON.parse(current.source_config)
                      patch.source_config = { ...currentSc }
                      if (args.cron_expr) patch.source_config.cron_expr = args.cron_expr
                      if (args.timezone) patch.source_config.timezone = args.timezone
                      if (args.path) patch.source_config.path = args.path
                      if (args.method) patch.source_config.method = args.method
                      if (args.secret) patch.source_config.secret = args.secret
                    }
                  }
                  if (args.prompt || args.command || args.url) {
                    const current = store.get(args.trigger_id)
                    if (current) {
                      const currentAc = JSON.parse(current.action_config)
                      patch.action_config = { ...currentAc }
                      if (args.prompt) patch.action_config.prompt = args.prompt
                      if (args.command) patch.action_config.command = args.command
                      if (args.url) patch.action_config.url = args.url
                    }
                  }
                  if (args.agent_name) patch.agent_name = args.agent_name
                  if (args.model_id) patch.model_id = args.model_id
                  if (args.session_mode) patch.session_mode = args.session_mode

                  const trigger = manager.updateTrigger(args.trigger_id, patch)
                  if (!trigger) return `Error: Trigger not found: ${args.trigger_id}`
                  return `Trigger updated: ${trigger.name}\n${formatTriggerForDisplay(trigger)}`
                }

                case "delete": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const deleted = manager.deleteTrigger(args.trigger_id)
                  return deleted ? "Trigger deleted." : `Error: Trigger not found: ${args.trigger_id}`
                }

                case "pause": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const trigger = manager.pauseTrigger(args.trigger_id)
                  return trigger ? `Trigger paused: ${trigger.name}` : `Error: Trigger not found: ${args.trigger_id}`
                }

                case "resume": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const trigger = manager.resumeTrigger(args.trigger_id)
                  return trigger ? `Trigger resumed: ${trigger.name}` : `Error: Trigger not found: ${args.trigger_id}`
                }

                case "run": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const result = await manager.runTrigger(args.trigger_id)
                  if (!result) return `Error: Trigger not found: ${args.trigger_id}`
                  return `Trigger fired manually. Execution: ${result.executionId}`
                }

                case "executions": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const trigger = store.get(args.trigger_id) ?? store.getByName(args.trigger_id)
                  if (!trigger) return `Error: Trigger not found: ${args.trigger_id}`
                  const result = store.listExecutions({ triggerId: trigger.id })
                  if (result.data.length === 0) return "No executions yet."
                  return JSON.stringify(result.data.slice(0, 20), null, 2)
                }

                case "sync": {
                  const result = manager.sync()
                  return `Sync complete: ${result.created} created, ${result.updated} updated, ${result.removed} removed\n${result.details.join("\n")}`
                }

                default:
                  return "Error: Unknown action. Use: list, create, get, update, delete, pause, resume, run, executions, sync"
              }
            } catch (err) {
              return `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          },
        }),

        // ─── Backward compat aliases ──────────────────────────────────────
        agent_triggers: tool({
          description: "List all triggers. (Alias for: triggers action=list)",
          args: {},
          async execute() {
            const triggers = manager.getStore().list()
            if (triggers.length === 0) return "No triggers configured."
            const lines = [`=== TRIGGERS (${triggers.length}) ===`, `Webhook base URL: ${manager.getPublicBaseUrl()}`, ""]
            for (const t of triggers) lines.push(formatTriggerForDisplay(t))
            return lines.join("\n")
          },
        }),

        sync_agent_triggers: tool({
          description: "Re-read triggers.yaml and sync to DB. (Alias for: triggers action=sync)",
          args: {},
          async execute() {
            const result = manager.sync()
            return `Sync: ${result.created} created, ${result.updated} updated, ${result.removed} removed\n${result.details.join("\n")}`
          },
        }),

        cron_triggers: tool({
          description: "Manage cron triggers. (Alias — use the unified 'triggers' tool instead.) Actions: create, list, get, update, delete, pause, resume, run, executions.",
          args: {
            action: tool.schema.string(),
            trigger_id: tool.schema.string().optional(),
            name: tool.schema.string().optional(),
            cron_expr: tool.schema.string().optional(),
            prompt: tool.schema.string().optional(),
            timezone: tool.schema.string().optional(),
            agent_name: tool.schema.string().optional(),
            model_id: tool.schema.string().optional(),
            session_mode: tool.schema.string().optional(),
          },
          async execute(args) {
            try {
              const store = manager.getStore()
              switch (args.action) {
                case "list":
                  return JSON.stringify(store.list({ source_type: "cron" }), null, 2)
                case "create": {
                  if (!args.name || !args.cron_expr || !args.prompt) return "Error: name, cron_expr, and prompt are required."
                  const trigger = manager.createTrigger({
                    name: args.name,
                    source_type: "cron",
                    source_config: { cron_expr: args.cron_expr, timezone: args.timezone ?? "UTC" },
                    action_type: "prompt",
                    action_config: { prompt: args.prompt },
                    agent_name: args.agent_name,
                    model_id: args.model_id,
                    session_mode: args.session_mode ?? "new",
                  })
                  return JSON.stringify(trigger, null, 2)
                }
                case "get": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const t = store.get(args.trigger_id) ?? store.getByName(args.trigger_id)
                  return JSON.stringify(t, null, 2)
                }
                case "update": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const patch: any = {}
                  if (args.name) patch.name = args.name
                  if (args.cron_expr) patch.source_config = { cron_expr: args.cron_expr, timezone: args.timezone }
                  if (args.prompt) patch.action_config = { prompt: args.prompt }
                  if (args.agent_name) patch.agent_name = args.agent_name
                  if (args.model_id) patch.model_id = args.model_id
                  if (args.session_mode) patch.session_mode = args.session_mode
                  const t = manager.updateTrigger(args.trigger_id, patch)
                  return t ? JSON.stringify(t, null, 2) : "Error: not found"
                }
                case "delete": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  return JSON.stringify({ ok: manager.deleteTrigger(args.trigger_id) })
                }
                case "pause": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const t = manager.pauseTrigger(args.trigger_id)
                  return t ? JSON.stringify(t, null, 2) : "Error: not found"
                }
                case "resume": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const t = manager.resumeTrigger(args.trigger_id)
                  return t ? JSON.stringify(t, null, 2) : "Error: not found"
                }
                case "run": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const result = await manager.runTrigger(args.trigger_id)
                  return result ? JSON.stringify({ execution_id: result.executionId }) : "Error: not found"
                }
                case "executions": {
                  if (!args.trigger_id) return "Error: trigger_id is required."
                  const t = store.get(args.trigger_id) ?? store.getByName(args.trigger_id)
                  if (!t) return "Error: not found"
                  return JSON.stringify(store.listExecutions({ triggerId: t.id }).data, null, 2)
                }
                default:
                  return "Error: Unknown action."
              }
            } catch (err) {
              return `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          },
        }),

        event_triggers: tool({
          description: "Manage Pipedream event triggers. (Alias — use the unified 'triggers' tool for new triggers.)\nActions: list_available, setup, list, get, remove, pause, resume.",
          args: {
            action: tool.schema.string(),
            app: tool.schema.string().optional(),
            query: tool.schema.string().optional(),
            name: tool.schema.string().optional(),
            component_key: tool.schema.string().optional(),
            configured_props: tool.schema.string().optional(),
            prompt: tool.schema.string().optional(),
            agent_name: tool.schema.string().optional(),
            model_id: tool.schema.string().optional(),
            session_mode: tool.schema.string().optional(),
            listener_id: tool.schema.string().optional(),
          },
          async execute(args) {
            try {
              const store = manager.getStore()
              switch (args.action) {
                case "list_available": {
                  if (!args.app) return "Error: app is required."
                  const params = new URLSearchParams({ app: args.app })
                  if (args.query) params.set("q", args.query)
                  const res = await fetch(`http://localhost:8000/api/pipedream/triggers/available?${params}`, { signal: AbortSignal.timeout(15_000) })
                  if (!res.ok) return `Error: ${res.status} ${await res.text()}`
                  return JSON.stringify(await res.json(), null, 2)
                }
                case "setup": {
                  if (!args.name || !args.app || !args.component_key || !args.prompt) {
                    return "Error: name, app, component_key, and prompt are required."
                  }
                  let configuredProps: Record<string, unknown> = {}
                  if (args.configured_props) {
                    try { configuredProps = JSON.parse(args.configured_props) } catch { return "Error: configured_props must be valid JSON." }
                  }
                  // Create as a webhook trigger with Pipedream metadata
                  const listenerId = crypto.randomUUID()
                  const webhookPath = `/events/pipedream/${listenerId}`
                  const publicUrl = manager.getPublicBaseUrl()

                  // Deploy via Pipedream
                  const deployRes = await fetch("http://localhost:8000/api/pipedream/triggers/deploy", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      app: args.app,
                      component_key: args.component_key,
                      configured_props: configuredProps,
                      webhook_url: `${publicUrl}${webhookPath}`,
                    }),
                    signal: AbortSignal.timeout(30_000),
                  })
                  if (!deployRes.ok) return `Error deploying Pipedream trigger: ${await deployRes.text()}`
                  const deployResult = await deployRes.json() as { deployedTriggerId: string }

                  const trigger = manager.createTrigger({
                    name: args.name,
                    source_type: "webhook",
                    source_config: { path: webhookPath, method: "POST" },
                    action_type: "prompt",
                    action_config: { prompt: args.prompt },
                    agent_name: args.agent_name ?? "kortix",
                    model_id: args.model_id,
                    session_mode: args.session_mode ?? "new",
                    pipedream_app: args.app,
                    pipedream_component: args.component_key,
                    pipedream_props: configuredProps,
                  })

                  // Store Pipedream deploy ID
                  store.update(trigger.id, {
                    pipedream_deployed_id: deployResult.deployedTriggerId,
                    pipedream_webhook_url: `${publicUrl}${webhookPath}`,
                  })

                  return `Event listener created: ${trigger.name}\n${JSON.stringify(store.get(trigger.id), null, 2)}`
                }
                case "list": {
                  const triggers = store.list({ source_type: "webhook" }).filter((t) => t.pipedream_app)
                  if (triggers.length === 0) return "No event listeners configured."
                  const lines = [`=== EVENT LISTENERS (${triggers.length}) ===`, ""]
                  for (const t of triggers) {
                    lines.push(`ID: ${t.id}`, `Name: ${t.name}`, `App: ${t.pipedream_app} | Trigger: ${t.pipedream_component}`, `Status: ${t.is_active ? "active" : "paused"} | Events: ${t.event_count}`, "")
                  }
                  return lines.join("\n")
                }
                case "get": {
                  if (!args.listener_id) return "Error: listener_id is required."
                  const t = store.get(args.listener_id)
                  return t ? JSON.stringify(t, null, 2) : "Error: not found"
                }
                case "remove": {
                  if (!args.listener_id) return "Error: listener_id is required."
                  const t = store.get(args.listener_id)
                  if (!t) return "Error: not found"
                  // Delete from Pipedream
                  if (t.pipedream_deployed_id) {
                    try {
                      await fetch(`http://localhost:8000/api/pipedream/triggers/deployed/${t.pipedream_deployed_id}`, { method: "DELETE", signal: AbortSignal.timeout(15_000) })
                    } catch {}
                  }
                  manager.deleteTrigger(t.id)
                  return "Listener removed."
                }
                case "pause": {
                  if (!args.listener_id) return "Error: listener_id is required."
                  const t = manager.pauseTrigger(args.listener_id)
                  return t ? `Paused: ${t.name}` : "Error: not found"
                }
                case "resume": {
                  if (!args.listener_id) return "Error: listener_id is required."
                  const t = manager.resumeTrigger(args.listener_id)
                  return t ? `Resumed: ${t.name}` : "Error: not found"
                }
                default:
                  return "Error: Unknown action."
              }
            } catch (err) {
              return `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          },
        }),
      },
    }
  }
  return plugin
}

/** @deprecated Use createTriggersPlugin */
export const createAgentTriggersPlugin = createTriggersPlugin

export default createTriggersPlugin
