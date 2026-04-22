/**
 * Prompt Action — Send a prompt to an OpenCode agent session.
 * This is the existing dispatch behavior, extracted into its own module.
 */
import type { MinimalOpenCodeClient, TriggerRecord, ExecutionRecord, PromptActionConfig, ContextConfig } from "../types.js"
import { Database } from "bun:sqlite"
import { join } from "path"
import {
  getAgentBySlug,
  setTicketAgentSession,
} from "../../../src/services/ticket-service"

function getWorkspaceDbPath(): string {
  const root = process.env.WORKSPACE_DIR || process.env.KORTIX_WORKSPACE || "/workspace"
  return join(root, ".kortix", "kortix.db")
}

/**
 * Bind a freshly-created trigger-dispatched session to the project + (if
 * ticket-bound) the agent slug the trigger fires, so downstream tool calls
 * (ticket_comment / ticket_update / ticket_create) can resolve actor to the
 * real agent via findAgentForSession. Without this, a board-sweep cron's
 * comments land with actor_type="user" — the UI attributes them to the human.
 */
function registerTriggerSession(
  sessionId: string,
  trigger: TriggerRecord,
  agentSlug: string | null | undefined,
): void {
  const projectId = (trigger as any).project_id as string | null | undefined
  const ticketId = (trigger as any).ticket_id as string | null | undefined
  if (!projectId) return
  let db: Database | null = null
  try {
    db = new Database(getWorkspaceDbPath())
    db.exec("PRAGMA busy_timeout=5000")
    db.prepare(
      "INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)",
    ).run({ $sid: sessionId, $pid: projectId, $now: new Date().toISOString() })
    if (ticketId && agentSlug) {
      const agent = getAgentBySlug(db, projectId, agentSlug)
      if (agent) setTicketAgentSession(db, ticketId, agent.id, sessionId)
    }
  } catch (err) {
    console.warn(`[prompt-action] registerTriggerSession failed:`, err instanceof Error ? err.message : err)
  } finally {
    try { db?.close() } catch {}
  }
}

function parseModel(modelId?: string | null): { providerID: string; modelID: string } | undefined {
  if (!modelId) return undefined
  const [providerID, ...rest] = modelId.split("/")
  if (!providerID || rest.length === 0) return { providerID: "kortix", modelID: modelId }
  return { providerID, modelID: rest.join("/") }
}

function getPathValue(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined
    return (current as Record<string, unknown>)[part]
  }, input)
}

function renderPrompt(template: string, values: Record<string, unknown>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (_, key: string) => {
    const value = values[key]
    if (value === null || value === undefined) return ""
    if (typeof value === "string") return value
    return JSON.stringify(value)
  })
}

export interface PromptActionResult {
  sessionId: string
}

export async function executePromptAction(
  client: MinimalOpenCodeClient,
  trigger: TriggerRecord,
  event: { type: string; data?: unknown; manual?: boolean; timestamp: string },
  options: { directory?: string; reusedSessions: Map<string, string> },
): Promise<PromptActionResult> {
  const actionConfig = JSON.parse(trigger.action_config) as PromptActionConfig
  const contextConfig = JSON.parse(trigger.context_config || "{}") as ContextConfig
  const prompt = actionConfig.prompt ?? ""

  // Extract context values from event data
  const extracted: Record<string, unknown> = {}
  if (contextConfig.extract && event.data) {
    for (const [key, extractPath] of Object.entries(contextConfig.extract)) {
      extracted[key] = getPathValue(event, extractPath)
    }
  }

  // Flatten top-level event data fields for template rendering
  const flatData: Record<string, unknown> = {}
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    for (const [key, value] of Object.entries(event.data as Record<string, unknown>)) {
      flatData[key] = value
    }
  }

  // Build prompt text
  const renderedPrompt = renderPrompt(prompt, { ...flatData, ...extracted })
  const sections = [renderedPrompt]

  if (Object.keys(extracted).length > 0) {
    sections.push("", "<trigger_context_values>", JSON.stringify(extracted, null, 2), "</trigger_context_values>")
  }

  // Surface the additive scoping columns (project_id, ticket_id) in the
  // event payload. The columns live outside the engine's type but the
  // dispatcher sees the raw record, so the agent gets the linkage for free
  // and can call ticket_get / ticket_comment against the bound ticket.
  const ticketId = (trigger as any).ticket_id as string | null | undefined
  const projectId = (trigger as any).project_id as string | null | undefined
  const normalizedEvent = {
    type: event.type,
    trigger: trigger.name,
    ...(projectId ? { project_id: projectId } : {}),
    ...(ticketId ? { ticket_id: ticketId } : {}),
    data: event.data ?? { timestamp: event.timestamp, manual: event.manual ?? false },
  }

  if (contextConfig.include_raw !== false) {
    sections.push("", "<trigger_event>", JSON.stringify(normalizedEvent, null, 2), "</trigger_event>")
  }

  const bodyText = sections.join("\n")

  // Session management
  const agentName = trigger.agent_name ?? actionConfig.agent
  const modelId = trigger.model_id ?? actionConfig.model
  // A ticket-bound trigger implies the ticket IS the thread — force reuse so
  // every fire lands on the same per-ticket session and the agent sees prior
  // fires in its history. The DB default for session_mode is "new" (not
  // null), so we have to branch on ticketId before the nullish chain.
  const sessionMode = ticketId
    ? "reuse"
    : (trigger.session_mode ?? actionConfig.session_mode ?? "new")
  // Dynamic reuse key: render session_key template with extracted values
  // so each unique key (e.g. per chat_id) gets its own persistent session.
  // When the trigger is bound to a ticket and no explicit template is set,
  // default to a per-ticket key so repeated fires thread onto one session
  // (the ticket becomes the running review thread).
  const hasDynamicKey = !!contextConfig.session_key
  const reuseKey = hasDynamicKey
    ? renderPrompt(contextConfig.session_key!, { ...flatData, ...extracted })
    : ticketId
      ? `ticket:${ticketId}`
      : `trigger:${trigger.name}`
  // With a dynamic key, only check the reusedSessions map (not trigger.session_id,
  // which is a single-value fallback for the "one session per trigger" pattern).
  let sessionId = sessionMode === "reuse"
    ? (options.reusedSessions.get(reuseKey) ?? (hasDynamicKey ? undefined : trigger.session_id) ?? undefined)
    : undefined

  // Probe the reused session. If it's been deleted from opencode (user
  // wiped it, restart cleared state, ttl expired) we'd otherwise dispatch
  // to a dead id and promptAsync silently no-ops — session stays empty,
  // no messages ever appear, trigger executions all report "completed"
  // while nothing actually runs. Drop the stale id so the create-path
  // below mints a fresh session.
  if (sessionId) {
    try {
      const probe = await (client as unknown as { session: { get: (args: { path: { id: string } }) => Promise<unknown> } }).session.get?.({ path: { id: sessionId } }) as { data?: { id?: string }; id?: string } | undefined
      const resolvedId = (probe as { data?: { id?: string } })?.data?.id ?? (probe as { id?: string })?.id
      if (!resolvedId) throw new Error("session.get returned no id")
    } catch {
      options.reusedSessions.delete(reuseKey)
      sessionId = undefined
    }
  }

  // Resolve the project's actual directory (where its `.opencode/agent/`
  // tree lives) — opencode looks up agents per-directory, so without
  // this query.directory below, dispatching to a per-project agent slug
  // (engineer / qa / tech-lead) silently no-ops because opencode only
  // sees the global agent list.
  const projectDirectory = projectId
    ? (() => {
        let probeDb: Database | null = null
        try {
          probeDb = new Database(getWorkspaceDbPath())
          probeDb.exec("PRAGMA busy_timeout=5000")
          const row = probeDb.prepare("SELECT path FROM projects WHERE id=$id").get({ $id: projectId }) as { path?: string } | undefined
          return row?.path
        } catch { return undefined }
        finally { try { probeDb?.close() } catch {} }
      })()
    : undefined
  const dispatchDirectory = projectDirectory ?? options.directory

  if (!sessionId) {
    const created = await client.session.create({
      body: {
        directory: dispatchDirectory,
        title: trigger.name,
      },
    }) as { data?: { id: string }; id?: string }
    sessionId = created.data?.id ?? created.id
    if (!sessionId) throw new Error("session.create did not return an id")
    if (sessionMode === "reuse") options.reusedSessions.set(reuseKey, sessionId)
    // Bind fresh session to project (+ ticket-agent when ticket-bound) so
    // subsequent tool calls resolve actor to the real agent.
    registerTriggerSession(sessionId, trigger, agentName)
  }

  await client.session.promptAsync({
    path: { id: sessionId },
    // Pass directory in query — opencode resolves per-project agents
    // (in <dir>/.opencode/agent/<slug>.md) against this. Without it,
    // promptAsync returns 2xx but no LLM loop runs because the agent
    // slug isn't visible in the workspace-root agent cache.
    query: { directory: dispatchDirectory },
    body: {
      agent: agentName ?? undefined,
      model: parseModel(modelId),
      parts: [{ type: "text", text: bodyText }],
    },
  })

  return { sessionId }
}
